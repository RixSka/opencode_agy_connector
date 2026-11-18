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
import {
  AgyUsageRpc,
  type AgyAgentStatus,
  type AgyAgentsSnapshotDto,
  type AgySubagentDto,
  type AgySwarmDto,
  type AgySwarmMemberDto,
  type AgySwarmPostDto,
  type AgyUsageBucketDto,
  type AgyUsageSnapshotDto,
} from "./rpc.ts"
import {
  formatAgentStatusLabel,
  formatBucketLine,
  formatCompactAgentTokens,
  formatHeaderTitle,
  formatSubagentDetailLine,
  formatSubagentPrimaryLine,
  formatSubagentsHeaderTitle,
  formatSwarmBoardPreviewLine,
  formatSwarmHeaderTitle,
  formatSwarmMemberDetailLine,
  formatSwarmMemberPrimaryLine,
  formatSwarmMetaLine,
  formatSyncFooter,
  parseAgentsSnapshotDto,
  parseUsageSnapshotDto,
  shortGroupLabel,
} from "./tui-format.ts"

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
const asJsx = (node: unknown): JSX.Element => node as JSX.Element

const POLL_INTERVAL_MS = 120_000
const ACTIVE_AGENTS_POLL_MS = 5_000
const TICK_INTERVAL_MS = 30_000
const STARTUP_RETRY_DELAYS_MS = [1500, 4000, 8000] as const

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

function agentStatusColor(colors: SidebarColors, status: AgyAgentStatus): string {
  if (status === "working" || status === "done") return colors.ok
  if (status === "waiting") return colors.accent
  if (status === "blocked" || status === "stuck" || status === "quota") return colors.warn
  if (status === "error") return colors.err
  return colors.muted
}

function hasLiveAgents(snap: AgyAgentsSnapshotDto | null): boolean {
  if (!snap) return false
  const liveMember = snap.swarm?.members.some(
    (m) => m.status === "working" || m.status === "blocked" || m.status === "stuck",
  )
  if (liveMember) return true
  return snap.subagents.some((s) => s.status === "working" || s.status === "blocked" || s.status === "stuck")
}

function makeLine(textValue: string | (() => string), color: string, bold = false, wrapMode = "none") {
  const el = createElement("text")
  setProp(el, "wrapMode", wrapMode)
  if (bold) setProp(el, "attributes", TextAttributes.BOLD)
  setProp(el, "fg", color)
  insert(el, typeof textValue === "function" ? textValue : () => textValue)
  return el
}

function buildAgentsModalContent(
  context: TuiContext,
  colors: SidebarColors,
  agents: Accessor<AgyAgentsSnapshotDto | null>,
  onRefresh: () => Promise<void>,
) {
  const root = createElement("box")
  setProp(root, "flexDirection", "column")
  setProp(root, "width", "100%")
  setProp(root, "padding", 1)

  const topBar = createElement("box")
  setProp(topBar, "flexDirection", "row")
  setProp(topBar, "justifyContent", "space-between")
  setProp(topBar, "width", "100%")

  const heading = makeLine("Antigravity Swarm & Subagents", colors.base, true)
  const actionsBox = createElement("box")
  setProp(actionsBox, "flexDirection", "row")

  const refreshBtn = makeLine("[↻ Refresh] ", colors.accent)
  setProp(refreshBtn, "onMouseDown", () => {
    void onRefresh()
  })
  const closeBtn = makeLine("[Close]", colors.muted)
  setProp(closeBtn, "onMouseDown", () => {
    context.ui?.dialog?.clear?.()
  })
  insertNode(actionsBox, refreshBtn)
  insertNode(actionsBox, closeBtn)
  insertNode(topBar, heading)
  insertNode(topBar, actionsBox)
  insertNode(root, topBar)

  const body = createComponent<{
    readonly when: boolean
    readonly fallback?: JSX.Element
    readonly children: JSX.Element
  }>(Show, {
    get when() {
      const snap = agents()
      return Boolean(snap?.swarm || (snap?.subagents.length ?? 0) > 0)
    },
    get fallback() {
      return asJsx(
        makeLine(
          "No active Antigravity swarm or subagents for this session. Start one with /swarm <task>.",
          colors.muted,
          false,
          "word",
        ),
      )
    },
    get children() {
      const container = createElement("box")
      setProp(container, "flexDirection", "column")
      setProp(container, "width", "100%")
      setProp(container, "paddingTop", 1)

      const swarmBlock = createComponent<{
        readonly when: boolean
        readonly children: JSX.Element
      }>(Show, {
        get when() {
          return Boolean(agents()?.swarm)
        },
        get children() {
          const box = createElement("box")
          setProp(box, "flexDirection", "column")
          setProp(box, "width", "100%")

          const swarmTitle = makeLine(() => {
            const sw = agents()?.swarm
            if (!sw) return ""
            return `🐝 ${sw.title} (${sw.postCount} posts · head #${sw.head})`
          }, colors.base, true, "word")
          insertNode(box, swarmTitle)

          const goalLine = makeLine(() => {
            const sw = agents()?.swarm
            if (!sw?.goalTitle && !sw?.goalLine) return ""
            return [sw.goalTitle, sw.goalLine].filter(Boolean).join(" — ")
          }, colors.muted, false, "word")
          insertNode(box, goalLine)

          const rosterLabel = makeLine("\nRoster:", colors.accent, true)
          insertNode(box, rosterLabel)

          const rosterList = createElement("box")
          setProp(rosterList, "flexDirection", "column")
          insert(
            rosterList,
            createComponent(For, {
              get each() {
                return agents()?.swarm?.members ?? []
              },
              children: (m: AgySwarmMemberDto) => {
                const rowBox = createElement("box")
                setProp(rowBox, "flexDirection", "column")
                setProp(rowBox, "paddingTop", 0)
                const statusStr = formatAgentStatusLabel(m.status, m.blockedTool)
                const ctxTok = formatCompactAgentTokens(m.contextTokens)
                const outTok = formatCompactAgentTokens(m.outputTokens)
                const tokPart = ctxTok ? ` · ${ctxTok} ctx${outTok ? `/${outTok} out` : ""}` : ""
                const wsPart = m.workspaceMode !== "inherit" ? ` · ws:${m.workspaceMode}` : ""
                const line1 = makeLine(
                  `• ${m.name} [${m.role}] — ${statusStr}${m.model ? ` · ${m.model}` : ""} · ${m.steps} steps · ${m.posts} posts${m.unread > 0 ? ` (${m.unread} unread)` : ""}${tokPart}${wsPart}`,
                  agentStatusColor(colors, m.status),
                  false,
                  "word",
                )
                insertNode(rowBox, line1)
                if (m.failure) {
                  insertNode(rowBox, makeLine(`  ⚠ ${m.failure.kind}: ${m.failure.text}`, colors.err, false, "word"))
                } else if (m.activity) {
                  insertNode(
                    rowBox,
                    makeLine(
                      `  ${m.activityKind === "thinking" ? "💭" : "▸"} ${m.activity}`,
                      colors.muted,
                      false,
                      "word",
                    ),
                  )
                }
                return asJsx(rowBox)
              },
            }),
            null,
          )
          insertNode(box, rosterList)

          const postsBlock = createComponent<{
            readonly when: boolean
            readonly children: JSX.Element
          }>(Show, {
            get when() {
              return (agents()?.swarm?.recentPosts.length ?? 0) > 0
            },
            get children() {
              const pBox = createElement("box")
              setProp(pBox, "flexDirection", "column")
              insertNode(pBox, makeLine("\nRecent Board Posts:", colors.accent, true))
              const pList = createElement("box")
              setProp(pList, "flexDirection", "column")
              insert(
                pList,
                createComponent(For, {
                  get each() {
                    return (agents()?.swarm?.recentPosts ?? []).slice(-10)
                  },
                  children: (post: AgySwarmPostDto) => {
                    const clean = post.text.replace(/\s+/g, " ").trim()
                    const clipped = clean.length > 180 ? `${clean.slice(0, 179)}…` : clean
                    return asJsx(
                      makeLine(
                        `#${post.seq} @${post.agent}${post.time ? ` (${post.time})` : ""}: ${clipped}`,
                        colors.base,
                        false,
                        "word",
                      ),
                    )
                  },
                }),
                null,
              )
              insertNode(pBox, pList)
              return asJsx(pBox)
            },
          })
          insert(box, postsBlock, null)
          return asJsx(box)
        },
      })

      const subBlock = createComponent<{
        readonly when: boolean
        readonly children: JSX.Element
      }>(Show, {
        get when() {
          return (agents()?.subagents.length ?? 0) > 0
        },
        get children() {
          const box = createElement("box")
          setProp(box, "flexDirection", "column")
          setProp(box, "width", "100%")
          insertNode(box, makeLine("\nSubagents:", colors.accent, true))

          const sList = createElement("box")
          setProp(sList, "flexDirection", "column")
          insert(
            sList,
            createComponent(For, {
              get each() {
                return agents()?.subagents ?? []
              },
              children: (sub: AgySubagentDto) => {
                const rowBox = createElement("box")
                setProp(rowBox, "flexDirection", "column")
                const statusStr = formatAgentStatusLabel(sub.status, sub.blockedTool)
                const ctxTok = formatCompactAgentTokens(sub.contextTokens)
                const tokPart = ctxTok ? ` · ${ctxTok} ctx` : ""
                insertNode(
                  rowBox,
                  makeLine(
                    `• ${sub.role} (${sub.typeName}) — ${statusStr}${sub.model ? ` · ${sub.model}` : ""} · ${sub.steps} steps${tokPart}`,
                    agentStatusColor(colors, sub.status),
                    false,
                    "word",
                  ),
                )
                if (sub.failure) {
                  insertNode(rowBox, makeLine(`  ⚠ ${sub.failure.kind}: ${sub.failure.text}`, colors.err, false, "word"))
                } else if (sub.activity) {
                  insertNode(
                    rowBox,
                    makeLine(
                      `  ${sub.activityKind === "thinking" ? "💭" : "▸"} ${sub.activity}`,
                      colors.muted,
                      false,
                      "word",
                    ),
                  )
                }
                if (sub.initialPrompt) {
                  insertNode(rowBox, makeLine(`  Prompt: ${sub.initialPrompt}`, colors.muted, false, "word"))
                }
                if (sub.lastMessage) {
                  insertNode(rowBox, makeLine(`  Last: ${sub.lastMessage}`, colors.muted, false, "word"))
                }
                return asJsx(rowBox)
              },
            }),
            null,
          )
          insertNode(box, sList)
          return asJsx(box)
        },
      })

      insert(container, swarmBlock, null)
      insert(container, subBlock, null)
      return asJsx(container)
    },
  })

  insert(root, body, null)
  return asJsx(root)
}

function AgySidebarWidget(props: {
  readonly context: TuiContext
  readonly snapshot: Accessor<AgyUsageSnapshotDto | null>
  readonly agents: Accessor<AgyAgentsSnapshotDto | null>
  readonly refreshing: Accessor<boolean>
  readonly onRefresh: (forceRefresh: boolean, showToast: boolean) => Promise<void>
  readonly onOpenBoard: () => void
}) {
  const colors = resolveColors(props.context.theme)
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal(36)
  const [nowMs, setNowMs] = createSignal(Date.now())
  const [hovered, setHovered] = createSignal(false)
  const [boardHovered, setBoardHovered] = createSignal(false)

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
  const agentsSnap = () => props.agents()
  const swarm = () => agentsSnap()?.swarm ?? null
  const subagents = () => agentsSnap()?.subagents ?? []
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
  setProp(header, "onMouseOver", () => setHovered(true))
  setProp(header, "onMouseOut", () => setHovered(false))
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
    setProp(
      refreshBtn,
      "fg",
      isRefreshing() ? colors.warn : hovered() ? colors.base : colors.accent,
      prev,
    ),
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

  const swarmSection = createComponent<{
    readonly when: boolean
    readonly children: JSX.Element
  }>(Show, {
    get when() {
      return Boolean(swarm())
    },
    get children() {
      const box = createElement("box")
      setProp(box, "flexDirection", "column")
      setProp(box, "width", "100%")
      setProp(box, "paddingTop", 1)

      const sHeader = createElement("box")
      setProp(sHeader, "flexDirection", "row")
      setProp(sHeader, "justifyContent", "space-between")
      setProp(sHeader, "width", "100%")
      setProp(sHeader, "onMouseOver", () => setBoardHovered(true))
      setProp(sHeader, "onMouseOut", () => setBoardHovered(false))
      setProp(sHeader, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
        event?.stopPropagation?.()
        props.onOpenBoard()
      })

      const sTitle = createElement("text")
      setProp(sTitle, "wrapMode", "none")
      setProp(sTitle, "attributes", TextAttributes.BOLD)
      effect((prev: unknown) => setProp(sTitle, "fg", colors.base, prev))
      insert(sTitle, () => {
        const sw = swarm()
        return sw ? formatSwarmHeaderTitle(sw, width()) : ""
      })

      const boardBtn = createElement("text")
      setProp(boardBtn, "wrapMode", "none")
      effect((prev: unknown) =>
        setProp(boardBtn, "fg", boardHovered() ? colors.base : colors.accent, prev),
      )
      insert(boardBtn, () => (width() >= 28 ? "[Board]" : "[⊞]"))

      insertNode(sHeader, sTitle)
      insertNode(sHeader, boardBtn)

      const sMeta = createElement("text")
      setProp(sMeta, "wrapMode", "none")
      effect((prev: unknown) => setProp(sMeta, "fg", colors.muted, prev))
      insert(sMeta, () => {
        const sw = swarm()
        return sw ? formatSwarmMetaLine(sw, width()) : ""
      })

      const membersBox = createElement("box")
      setProp(membersBox, "flexDirection", "column")
      setProp(membersBox, "width", "100%")
      insert(
        membersBox,
        createComponent(For, {
          get each() {
            return swarm()?.members ?? []
          },
          children: (member: AgySwarmMemberDto) => {
            const mBox = createElement("box")
            setProp(mBox, "flexDirection", "column")
            setProp(mBox, "width", "100%")
            setProp(mBox, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
              event?.stopPropagation?.()
              props.onOpenBoard()
            })

            const line1 = createElement("text")
            setProp(line1, "wrapMode", "none")
            effect((prev: unknown) =>
              setProp(line1, "fg", agentStatusColor(colors, member.status), prev),
            )
            insert(line1, () => formatSwarmMemberPrimaryLine(member, width()))
            insertNode(mBox, line1)

            const detailShow = createComponent<{
              readonly when: boolean
              readonly children: JSX.Element
            }>(Show, {
              get when() {
                return Boolean(formatSwarmMemberDetailLine(member, nowMs(), width()))
              },
              get children() {
                const line2 = createElement("text")
                setProp(line2, "wrapMode", "none")
                effect((prev: unknown) =>
                  setProp(
                    line2,
                    "fg",
                    member.failure
                      ? colors.err
                      : member.blockedTool
                        ? colors.warn
                        : colors.muted,
                    prev,
                  ),
                )
                insert(line2, () => formatSwarmMemberDetailLine(member, nowMs(), width()))
                return asJsx(line2)
              },
            })
            insert(mBox, detailShow, null)
            return asJsx(mBox)
          },
        }),
        null,
      )

      const latestPostShow = createComponent<{
        readonly when: boolean
        readonly children: JSX.Element
      }>(Show, {
        get when() {
          return (swarm()?.recentPosts.length ?? 0) > 0
        },
        get children() {
          const pText = createElement("text")
          setProp(pText, "wrapMode", "none")
          effect((prev: unknown) => setProp(pText, "fg", colors.muted, prev))
          setProp(pText, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
            event?.stopPropagation?.()
            props.onOpenBoard()
          })
          insert(pText, () => {
            const posts = swarm()?.recentPosts
            const latest = posts?.[posts.length - 1]
            return latest ? formatSwarmBoardPreviewLine(latest, width()) : ""
          })
          return asJsx(pText)
        },
      })

      insertNode(box, sHeader)
      insertNode(box, sMeta)
      insertNode(box, membersBox)
      insert(box, latestPostShow, null)
      return asJsx(box)
    },
  })

  const subagentsSection = createComponent<{
    readonly when: boolean
    readonly children: JSX.Element
  }>(Show, {
    get when() {
      return subagents().length > 0
    },
    get children() {
      const box = createElement("box")
      setProp(box, "flexDirection", "column")
      setProp(box, "width", "100%")
      setProp(box, "paddingTop", 1)

      const subHeader = createElement("box")
      setProp(subHeader, "flexDirection", "row")
      setProp(subHeader, "justifyContent", "space-between")
      setProp(subHeader, "width", "100%")
      setProp(subHeader, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
        event?.stopPropagation?.()
        props.onOpenBoard()
      })

      const subTitle = createElement("text")
      setProp(subTitle, "wrapMode", "none")
      setProp(subTitle, "attributes", TextAttributes.BOLD)
      effect((prev: unknown) => setProp(subTitle, "fg", colors.base, prev))
      insert(subTitle, () => formatSubagentsHeaderTitle(subagents(), width()))

      const inspectBtn = createElement("text")
      setProp(inspectBtn, "wrapMode", "none")
      effect((prev: unknown) => setProp(inspectBtn, "fg", colors.accent, prev))
      insert(inspectBtn, () => (width() >= 30 ? "[Inspect]" : "[⊞]"))

      insertNode(subHeader, subTitle)
      insertNode(subHeader, inspectBtn)

      const subsList = createElement("box")
      setProp(subsList, "flexDirection", "column")
      setProp(subsList, "width", "100%")
      insert(
        subsList,
        createComponent(For, {
          get each() {
            return subagents()
          },
          children: (sub: AgySubagentDto) => {
            const sBox = createElement("box")
            setProp(sBox, "flexDirection", "column")
            setProp(sBox, "width", "100%")
            setProp(sBox, "onMouseDown", (event?: { stopPropagation?: () => void }) => {
              event?.stopPropagation?.()
              props.onOpenBoard()
            })

            const line1 = createElement("text")
            setProp(line1, "wrapMode", "none")
            effect((prev: unknown) =>
              setProp(line1, "fg", agentStatusColor(colors, sub.status), prev),
            )
            insert(line1, () => formatSubagentPrimaryLine(sub, width()))
            insertNode(sBox, line1)

            const detailShow = createComponent<{
              readonly when: boolean
              readonly children: JSX.Element
            }>(Show, {
              get when() {
                return Boolean(formatSubagentDetailLine(sub, nowMs(), width()))
              },
              get children() {
                const line2 = createElement("text")
                setProp(line2, "wrapMode", "none")
                effect((prev: unknown) =>
                  setProp(
                    line2,
                    "fg",
                    sub.failure
                      ? colors.err
                      : sub.blockedTool
                        ? colors.warn
                        : colors.muted,
                    prev,
                  ),
                )
                insert(line2, () => formatSubagentDetailLine(sub, nowMs(), width()))
                return asJsx(line2)
              },
            })
            insert(sBox, detailShow, null)
            return asJsx(sBox)
          },
        }),
        null,
      )

      insertNode(box, subHeader)
      insertNode(box, subsList)
      return asJsx(box)
    },
  })

  insertNode(root, header)
  insertNode(root, footer)
  insert(root, body, footer)
  insert(root, swarmSection, null)
  insert(root, subagentsSection, null)

  return root
}

/** OpenCode v2 TUI plugin adding Antigravity Quota, Swarm, and Subagents inspection to the right sidebar. */
export default Plugin.define({
  id: "agy",
  setup(context) {
    const rpc = context.client?.rpc ? context.client.rpc(AgyUsageRpc) : undefined
    const colors = resolveColors(context.theme)
    const [snapshot, setSnapshot] = createSignal<AgyUsageSnapshotDto | null>(null)
    const [agentsSnapshot, setAgentsSnapshot] = createSignal<AgyAgentsSnapshotDto | null>(null)
    const [activeSessionID, setActiveSessionID] = createSignal<string>("")
    const [refreshing, setRefreshing] = createSignal(false)
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let startupRetryIndex = 0

    const currentRouteSessionID = () => {
      const route = context.ui?.router?.current?.()
      return route?.type === "session" ? route.sessionID : ""
    }

    const resolveSessionID = (explicit?: string) => explicit || activeSessionID() || currentRouteSessionID()

    const hasQuota = () => (snapshot()?.quotaGroups.length ?? 0) > 0

    const scheduleStartupRetry = () => {
      if (disposed || hasQuota() || retryTimer !== undefined) return
      const delayMs = STARTUP_RETRY_DELAYS_MS[startupRetryIndex]
      if (delayMs === undefined) return
      startupRetryIndex += 1
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (!disposed && !hasQuota()) {
          void refresh(false, false)
        }
      }, delayMs)
    }

    const refreshAgents = async (explicitSessionID?: string) => {
      const getAgentsFn = (rpc as { readonly getAgents?: unknown } | undefined)?.getAgents
      if (disposed || typeof getAgentsFn !== "function") return
      const sessionID = resolveSessionID(explicitSessionID)
      if (!sessionID) return
      try {
        const callOpts = context.location ? { location: context.location } : undefined
        const res = (await (
          getAgentsFn as (input: { sessionID: string }, opts?: unknown) => Promise<{ readonly json?: unknown }>
        )({ sessionID }, callOpts)) as { readonly json?: unknown } | undefined
        const parsed = parseAgentsSnapshotDto(res?.json)
        if (parsed && (!parsed.sessionID || parsed.sessionID === resolveSessionID())) {
          setAgentsSnapshot(parsed)
        }
      } catch {
        // Ignore transient RPC errors when server is restarting.
      }
    }

    const refresh = async (forceRefresh = false, showToast = false) => {
      if (disposed || !rpc || refreshing()) return
      setRefreshing(true)
      try {
        const callOpts = context.location ? { location: context.location } : undefined
        const res = (await rpc.getUsage({ forceRefresh }, callOpts)) as
          | { readonly json?: unknown }
          | undefined
        const parsed = parseUsageSnapshotDto(res?.json)
        if (parsed) {
          setSnapshot(parsed)
          if (parsed.quotaGroups.length === 0 && !forceRefresh) {
            scheduleStartupRetry()
          }
          if (showToast) {
            context.ui?.toast?.show({
              title: "Antigravity Quota",
              message: `Aggiornato (${parsed.quotaGroups.length} bucket · ${parsed.planTier})`,
              variant: "info",
            })
          }
        } else if (!forceRefresh) {
          scheduleStartupRetry()
        }
        await refreshAgents()
      } catch (err) {
        if (!forceRefresh) {
          scheduleStartupRetry()
        }
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

    const openBoardModal = () => {
      void refreshAgents()
      context.ui?.dialog?.set?.({ size: "large" })
      context.ui?.dialog?.show?.(() =>
        buildAgentsModalContent(context, colors, agentsSnapshot, () => refreshAgents()),
      )
    }

    void refresh(false, false)

    const offUpdated = rpc?.events?.on?.("updated", ({ data }) => {
      const payload = data as { readonly json?: unknown } | undefined
      const parsed = parseUsageSnapshotDto(payload?.json)
      if (parsed) setSnapshot(parsed)
    })

    const offAgentsUpdated = rpc?.events?.on?.("agentsUpdated", ({ data }) => {
      const payload = data as { readonly sessionID?: unknown; readonly json?: unknown } | undefined
      const currentSid = resolveSessionID()
      if (
        typeof payload?.sessionID === "string" &&
        currentSid &&
        payload.sessionID !== currentSid
      ) {
        return
      }
      const parsed = parseAgentsSnapshotDto(payload?.json)
      if (parsed) setAgentsSnapshot(parsed)
    })

    const pollTimer = setInterval(() => {
      void refresh(true, false)
    }, POLL_INTERVAL_MS)

    const liveAgentsPollTimer = setInterval(() => {
      const sid = resolveSessionID()
      if (!sid) return
      const sessionRunning = context.data?.session?.status?.(sid) === "running"
      if (sessionRunning || hasLiveAgents(agentsSnapshot())) {
        void refreshAgents(sid)
      }
    }, ACTIVE_AGENTS_POLL_MS)

    const cleanups: Array<() => void> = []
    if (context.ui?.slot) {
      cleanups.push(
        context.ui.slot({
          append: "sidebar.content",
          render: (slotInput?: { readonly sessionID?: string }) => {
            const sid = slotInput?.sessionID || currentRouteSessionID()
            if (sid && sid !== activeSessionID()) {
              setActiveSessionID(sid)
              void refreshAgents(sid)
            }
            return asJsx(
              createComponent(AgySidebarWidget, {
                context,
                snapshot,
                agents: agentsSnapshot,
                refreshing,
                onRefresh: refresh,
                onOpenBoard: openBoardModal,
              }),
            )
          },
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
                {
                  id: "agy.swarm.board",
                  title: "Antigravity: inspect swarm & subagents",
                  group: "Antigravity",
                  palette: true,
                  slash: {
                    name: "agy-swarm",
                  },
                  run: () => {
                    openBoardModal()
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
      disposed = true
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      clearInterval(pollTimer)
      clearInterval(liveAgentsPollTimer)
      offUpdated?.()
      offAgentsUpdated?.()
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
