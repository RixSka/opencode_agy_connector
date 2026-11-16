import { TextAttributes } from "@opentui/core"
import {
  createComponent,
  createElement,
  effect,
  insert,
  insertNode,
  setProp,
  use,
  useTerminalDimensions,
} from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { AgyUsageRpc, type AgyUsageBucketDto, type AgyUsageSnapshotDto } from "./rpc.ts"

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
const asJsx = (node: unknown): JSX.Element => node as JSX.Element
import {
  formatBucketLine,
  formatHeaderTitle,
  formatSyncFooter,
  parseUsageSnapshotDto,
  shortGroupLabel,
} from "./tui-format.ts"

const POLL_INTERVAL_MS = 120_000
const TICK_INTERVAL_MS = 30_000

interface SidebarColors {
  readonly base: string
  readonly muted: string
  readonly ok: string
  readonly warn: string
  readonly err: string
  readonly accent: string
}

function resolveColors(theme: TuiContext["theme"]): SidebarColors {
  const th = theme as unknown as Record<string, any>
  const base = typeof th?.text?.base === "string" ? th.text.base : "#e2e8f0"
  const muted = typeof th?.text?.muted === "string" ? th.text.muted : "#94a3b8"
  const ok =
    typeof th?.text?.feedback?.success?.base === "string"
      ? th.text.feedback.success.base
      : typeof th?.success === "string"
        ? th.success
        : "#4ade80"
  const warn =
    typeof th?.text?.feedback?.warning?.base === "string"
      ? th.text.feedback.warning.base
      : typeof th?.warning === "string"
        ? th.warning
        : "#fbbf24"
  const err =
    typeof th?.text?.feedback?.error?.base === "string"
      ? th.text.feedback.error.base
      : typeof th?.error === "string"
        ? th.error
        : "#f87171"
  const accent =
    typeof th?.text?.action?.primary?.selected === "string" ? th.text.action.primary.selected : base
  return { base, muted, ok, warn, err, accent }
}

function bucketColor(colors: SidebarColors, pct: number): string {
  if (pct <= 0) return colors.err
  if (pct <= 25) return colors.warn
  return colors.ok
}

function AgySidebarWidget(props: {
  readonly context: TuiContext
  readonly snapshot: Accessor<AgyUsageSnapshotDto | null>
  readonly refreshing: Accessor<boolean>
  readonly onRefresh: (forceRefresh: boolean, showToast: boolean) => Promise<void>
}) {
  const colors = resolveColors(props.context.theme)
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal(36)
  const [nowMs, setNowMs] = createSignal(Date.now())

  let targetEl: { getLayout?: () => { width: number } } | undefined
  let measureTimer: ReturnType<typeof setTimeout> | undefined

  const measure = (remaining = 8) => {
    if (measureTimer !== undefined) clearTimeout(measureTimer)
    measureTimer = setTimeout(() => {
      measureTimer = undefined
      if (!targetEl?.getLayout) return
      let measured = 0
      try {
        measured = targetEl.getLayout().width
      } catch {
        return
      }
      if (measured > 0) {
        setWidth(measured)
        return
      }
      if (remaining > 1) measure(remaining - 1)
    }, 0)
  }

  const tickTimer = setInterval(() => setNowMs(Date.now()), TICK_INTERVAL_MS)
  createEffect(() => {
    dimensions()
    measure()
  })
  onCleanup(() => {
    clearInterval(tickTimer)
    if (measureTimer !== undefined) clearTimeout(measureTimer)
  })

  const snap = () => props.snapshot()
  const isRefreshing = () => props.refreshing()
  const groups = () => snap()?.quotaGroups ?? []
  const maxLabelWidth = () => {
    const compact = width() < 38
    return groups().reduce(
      (max, bucket) => Math.max(max, shortGroupLabel(bucket.modelGroup, bucket.window, compact).length),
      10,
    )
  }

  const root = createElement("box")
  use(
    (el: unknown) => {
      targetEl = el as { getLayout?: () => { width: number } }
      measure()
    },
    root,
    undefined,
  )
  setProp(root, "flexDirection", "column")
  setProp(root, "width", "100%")
  setProp(root, "paddingTop", 1)

  const header = createElement("box")
  setProp(header, "flexDirection", "row")
  setProp(header, "justifyContent", "space-between")
  setProp(header, "width", "100%")
  setProp(header, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.()
    void props.onRefresh(true, true)
  })

  const titleText = createElement("text")
  setProp(titleText, "wrapMode", "none")
  setProp(titleText, "attributes", TextAttributes.BOLD)
  effect((prev: unknown) => setProp(titleText, "fg", colors.base, prev))
  insert(titleText, () => formatHeaderTitle(snap(), width()))

  const refreshBtn = createElement("text")
  setProp(refreshBtn, "wrapMode", "none")
  effect((prev: unknown) =>
    setProp(refreshBtn, "fg", isRefreshing() ? colors.warn : colors.accent, prev),
  )
  insert(refreshBtn, () => {
    const w = width()
    if (isRefreshing()) return w >= 28 ? "[↻ syncing]" : "[↻ …]"
    return w >= 26 ? "[↻ Refresh]" : "[↻]"
  })

  insertNode(header, titleText)
  insertNode(header, refreshBtn)

  const footer = createElement("text")
  setProp(footer, "wrapMode", "none")
  effect((prev: unknown) => setProp(footer, "fg", colors.muted, prev))
  insert(footer, () => formatSyncFooter(snap()?.updatedAt, width()))

  const body = createComponent<{
    readonly when: boolean
    readonly fallback?: JSX.Element
    readonly children: JSX.Element
  }>(Show, {
    get when() {
      return groups().length > 0
    },
    get fallback() {
      const statusLine = createElement("text")
      setProp(statusLine, "wrapMode", "none")
      effect((prev: unknown) =>
        setProp(statusLine, "fg", snap()?.error ? colors.err : colors.muted, prev),
      )
      insert(statusLine, () => {
        const err = snap()?.error
        if (err) return `Error: ${err.slice(0, Math.max(12, width() - 7))}`
        return isRefreshing() ? "Loading Antigravity quota..." : "Click [↻ Refresh] to load"
      })
      return asJsx(statusLine)
    },
    get children() {
      const listBox = createElement("box")
      setProp(listBox, "flexDirection", "column")
      setProp(listBox, "width", "100%")
      insert(
        listBox,
        createComponent(For, {
          get each() {
            return groups()
          },
          children: (bucket: AgyUsageBucketDto) => {
            const row = createElement("text")
            setProp(row, "wrapMode", "none")
            effect((prev: unknown) =>
              setProp(row, "fg", bucketColor(colors, Number(bucket.remainingPct ?? 0)), prev),
            )
            insert(row, () => formatBucketLine(bucket, nowMs(), width(), maxLabelWidth()))
            return asJsx(row)
          },
        }),
        null,
      )
      return asJsx(listBox)
    },
  })

  insertNode(root, header)
  insertNode(root, footer)
  insert(root, body, footer)

  return root
}

/** OpenCode v2 TUI plugin adding an Antigravity Quota widget with manual & automatic refresh to the right sidebar. */
export default Plugin.define({
  id: "agy",
  setup(context) {
    const rpc = context.client?.rpc ? context.client.rpc(AgyUsageRpc) : undefined
    const [snapshot, setSnapshot] = createSignal<AgyUsageSnapshotDto | null>(null)
    const [refreshing, setRefreshing] = createSignal(false)

    const refresh = async (forceRefresh = false, showToast = false) => {
      if (!rpc || refreshing()) return
      setRefreshing(true)
      try {
        const callOpts = context.location ? { location: context.location } : undefined
        const res = (await rpc.getUsage({ forceRefresh }, callOpts)) as
          | { readonly json?: unknown }
          | undefined
        const parsed = parseUsageSnapshotDto(res?.json)
        if (parsed) {
          setSnapshot(parsed)
          if (showToast) {
            context.ui?.toast?.show({
              title: "Antigravity Quota",
              message: `Aggiornato (${parsed.quotaGroups.length} bucket · ${parsed.planTier})`,
              variant: "info",
            })
          }
        }
      } catch (err) {
        if (showToast) {
          context.ui?.toast?.show({
            title: "Antigravity Quota",
            message: err instanceof Error ? err.message : String(err),
            variant: "error",
          })
        }
      } finally {
        setRefreshing(false)
      }
    }

    void refresh(false, false)

    const offUpdated = rpc?.events?.on?.("updated", ({ data }) => {
      const payload = data as { readonly json?: unknown } | undefined
      const parsed = parseUsageSnapshotDto(payload?.json)
      if (parsed) setSnapshot(parsed)
    })

    const pollTimer = setInterval(() => {
      void refresh(true, false)
    }, POLL_INTERVAL_MS)

    const cleanups: Array<() => void> = []
    if (context.ui?.slot) {
      cleanups.push(
        context.ui.slot({
          append: "sidebar.content",
          render: () =>
            asJsx(
              createComponent(AgySidebarWidget, {
                context,
                snapshot,
                refreshing,
                onRefresh: refresh,
              }),
            ),
        }),
      )

      cleanups.push(
        context.ui.slot({
          append: "app",
          render() {
            context.keymap?.layer(() => ({
              mode: "global",
              commands: [
                {
                  id: "agy.usage.refresh",
                  title: "Antigravity: refresh quota usage",
                  group: "Antigravity",
                  palette: true,
                  slash: {
                    name: "agy-refresh",
                  },
                  run: () => {
                    void refresh(true, true)
                  },
                },
              ],
            }))
            return null
          },
        }),
      )
    }

    return () => {
      clearInterval(pollTimer)
      offUpdated?.()
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
    }
  },
})
