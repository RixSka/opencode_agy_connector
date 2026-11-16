import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { buildSanitizedEnv, resolveAddDirs, resolveAgyBinary, resolveTimeoutSeconds } from "../src/env.ts"

test("buildSanitizedEnv keeps allowlisted keys, locale/XDG prefixes, and local bin", () => {
  const env = buildSanitizedEnv({
    HOME: "/Users/tester",
    PATH: "/usr/bin:/bin",
    LC_ALL: "en_US.UTF-8",
    XDG_CONFIG_HOME: "/tmp/xdg",
    SECRET_TOKEN: "should-be-stripped",
    ANTHROPIC_API_KEY: "should-be-stripped",
  })

  assert.equal(env.CI, "1")
  assert.equal(env.NO_COLOR, "1")
  assert.equal(env.TERM, "dumb")
  assert.equal(env.LC_ALL, "en_US.UTF-8")
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/xdg")
  assert.equal(env.SECRET_TOKEN, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.PATH, `${path.join("/Users/tester", ".local", "bin")}${path.delimiter}/usr/bin:/bin`)
})

test("resolveAgyBinary prefers explicit option over AGY_BIN and PATH fallback", () => {
  assert.equal(resolveAgyBinary("/custom/agy", { AGY_BIN: "/env/agy" }), "/custom/agy")
  assert.equal(resolveAgyBinary(undefined, { AGY_BIN: "/env/agy" }), "/env/agy")
  assert.equal(resolveAgyBinary(undefined, {}), "agy")
})

test("resolveAddDirs resolves relative paths and rejects empty or null-byte entries", () => {
  const resolved = resolveAddDirs("/workspace/repo", ["../shared", "/abs/dir"])
  assert.deepEqual(resolved, [path.resolve("/workspace/repo", "../shared"), "/abs/dir"])

  assert.throws(() => resolveAddDirs("/workspace/repo", ["  "]), /Invalid add_dirs entry/)
  assert.throws(() => resolveAddDirs("/workspace/repo", ["bad\0dir"]), /Invalid add_dirs entry/)
})

test("resolveTimeoutSeconds clamps negative or fractional values cleanly", () => {
  assert.equal(resolveTimeoutSeconds(undefined, 600), 600)
  assert.equal(resolveTimeoutSeconds(0, 600), 0)
  assert.equal(resolveTimeoutSeconds(-5, 600), 0)
  assert.equal(resolveTimeoutSeconds(12.9, 600), 12)
  assert.equal(resolveTimeoutSeconds(Number.NaN, 600), 600)
})
