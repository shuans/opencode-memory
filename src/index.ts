import { Plugin } from "@opencode/plugin"
import os from "node:os"

const MEMORY_DIR = `${os.homedir()}/.config/opencode/memory`

const MEMORY_TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const

const getMemoryFile = () => {
  const date = new Date().toISOString().split("T")[0]
  return Bun.file(`${MEMORY_DIR}/${date}.logfmt`)
}

const ensureDir = async () => {
  const dir = Bun.file(MEMORY_DIR)
  if (!(await dir.exists())) {
    await Bun.$`mkdir -p ${MEMORY_DIR}`
  }
}

interface Memory {
  ts: string
  type: string
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

interface RememberArgs {
  type: string
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

interface RecallArgs {
  scope?: string
  type?: string
  query?: string
  limit?: number
}

interface UpdateArgs {
  scope: string
  type: string
  content: string
  query?: string
  issue?: string
  tags?: string[]
}

interface ForgetArgs {
  scope: string
  type: string
  reason: string
}

const parseLine = (line: string): Memory | null => {
  const tsMatch = line.match(/ts=([^\s]+)/)
  const typeMatch = line.match(/type=([^\s]+)/)
  const scopeMatch = line.match(/scope=([^\s]+)/)
  const contentMatch = line.match(/content="([^"]*(?:\\"[^"]*)*)"/)
  const issueMatch = line.match(/issue=([^\s]+)/)
  const tagsMatch = line.match(/tags=([^\s]+)/)

  if (!tsMatch?.[1] || !typeMatch?.[1] || !scopeMatch?.[1]) return null

  return {
    ts: tsMatch[1],
    type: typeMatch[1],
    scope: scopeMatch[1],
    content: contentMatch?.[1]?.replace(/\\"/g, '"') || "",
    issue: issueMatch?.[1],
    tags: tagsMatch?.[1]?.split(","),
  }
}

const formatMemory = (m: Memory): string => {
  const date = m.ts.split("T")[0]
  const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : ""
  const issue = m.issue ? ` (${m.issue})` : ""
  return `[${date}] ${m.type}/${m.scope}: ${m.content}${issue}${tags}`
}

const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.type} ${memory.scope} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.scope.toLowerCase() === word) score += 2
    if (memory.type.toLowerCase() === word) score += 2
  }
  return score
}

const getAllMemories = async (): Promise<Memory[]> => {
  const glob = new Bun.Glob("*.logfmt")
  const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

  if (!files.length) return []

  const lines: string[] = []
  for (const filename of files) {
    if (filename === "deletions.logfmt") continue // skip audit log
    const file = Bun.file(`${MEMORY_DIR}/${filename}`)
    const text = await file.text()
    lines.push(...text.trim().split("\n").filter(Boolean))
  }

  return lines.map(parseLine).filter((m): m is Memory => m !== null)
}

const logDeletion = async (memory: Memory, reason: string) => {
  await ensureDir()
  const ts = new Date().toISOString()
  const content = memory.content.replace(/"/g, '\\"')
  const originalTs = memory.ts
  const issue = memory.issue ? ` issue=${memory.issue}` : ""
  const tags = memory.tags?.length ? ` tags=${memory.tags.join(",")}` : ""
  const escapedReason = reason.replace(/"/g, '\\"')
  const line = `ts=${ts} action=deleted original_ts=${originalTs} type=${memory.type} scope=${memory.scope} content="${content}" reason="${escapedReason}"${issue}${tags}\n`

  const file = Bun.file(`${MEMORY_DIR}/deletions.logfmt`)
  const existing = (await file.exists()) ? await file.text() : ""
  await Bun.write(file, existing + line)
}

const remember = async (input: unknown) => {
  const args = input as RememberArgs
  await ensureDir()

  const ts = new Date().toISOString()
  const issue = args.issue ? ` issue=${args.issue}` : ""
  const tags = args.tags?.length ? ` tags=${args.tags.join(",")}` : ""
  const content = args.content.replace(/"/g, '\\"')
  const line = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issue}${tags}\n`

  const file = getMemoryFile()
  const existing = (await file.exists()) ? await file.text() : ""
  await Bun.write(file, existing + line)

  return { content: `Remembered: ${args.type} in ${args.scope}` }
}

const recall = async (input: unknown) => {
  const args = input as RecallArgs
  let results = await getAllMemories()

  if (!results.length) return { content: "No memories found" }

  const totalCount = results.length

  if (args.scope) {
    results = results.filter((m) => m.scope === args.scope || m.scope.includes(args.scope!))
  }
  if (args.type) {
    results = results.filter((m) => m.type === args.type)
  }

  if (args.query) {
    const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = results
      .map((m) => ({ memory: m, score: scoreMatch(m, words) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    results = scored.map((x) => x.memory)
  }

  const filteredCount = results.length
  const limit = args.limit || 20
  const limited = results.slice(-limit)

  if (!limited.length) return { content: "No matching memories" }

  const header =
    filteredCount > limit
      ? `Found ${filteredCount} memories (showing last ${limit} of ${totalCount} total)\n\n`
      : filteredCount !== totalCount
        ? `Found ${filteredCount} memories (${totalCount} total)\n\n`
        : `Found ${filteredCount} memories\n\n`

  return { content: header + limited.map(formatMemory).join("\n") }
}

const update = async (input: unknown) => {
  const args = input as UpdateArgs
  const glob = new Bun.Glob("*.logfmt")
  const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

  if (!files.length) return { content: "No memory files found" }

  // Find matching memories
  const matches: { memory: Memory; filepath: string; lineIndex: number }[] = []

  for (const filename of files) {
    if (filename === "deletions.logfmt") continue
    const filepath = `${MEMORY_DIR}/${filename}`
    const file = Bun.file(filepath)
    const text = await file.text()
    const lines = text.split("\n")

    lines.forEach((line, lineIndex) => {
      const memory = parseLine(line)
      if (!memory) return
      if (memory.scope === args.scope && memory.type === args.type) {
        matches.push({ memory, filepath, lineIndex })
      }
    })
  }

  if (matches.length === 0) {
    return { content: `No memories found for ${args.type} in ${args.scope}` }
  }

  // If multiple matches and query provided, filter by query
  let target: (typeof matches)[number] | undefined = matches[0]
  if (matches.length > 1) {
    if (args.query) {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
      const scored = matches
        .map((m) => ({ ...m, score: scoreMatch(m.memory, words) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)

      if (scored.length === 0) {
        return {
          content: `Found ${matches.length} memories for ${args.type}/${args.scope}, but none matched query "${args.query}". Use recall to see all matches.`,
        }
      }
      target = scored[0]
    } else {
      return {
        content: `Found ${matches.length} memories for ${args.type}/${args.scope}. Provide a query to select which one to update, or use recall to see all matches.`,
      }
    }
  }

  if (!target) {
    return { content: `No memories found for ${args.type} in ${args.scope}` }
  }

  // Log the old version before updating
  await logDeletion(target.memory, `Updated to: ${args.content}`)

  // Update the memory
  const file = Bun.file(target.filepath)
  const text = await file.text()
  const lines = text.split("\n")

  const ts = new Date().toISOString()
  const issue = args.issue !== undefined ? args.issue : target.memory.issue
  const tags = args.tags !== undefined ? args.tags : target.memory.tags
  const issueStr = issue ? ` issue=${issue}` : ""
  const tagsStr = tags?.length ? ` tags=${tags.join(",")}` : ""
  const content = args.content.replace(/"/g, '\\"')
  const newLine = `ts=${ts} type=${args.type} scope=${args.scope} content="${content}"${issueStr}${tagsStr}`

  lines[target.lineIndex] = newLine
  await Bun.write(target.filepath, lines.join("\n"))

  return { content: `Updated ${args.type} in ${args.scope}: "${args.content}"` }
}

const listMemories = async () => {
  const memories = await getAllMemories()

  if (!memories.length) return { content: "No memories found" }

  const scopes = new Map<string, number>()
  const types = new Map<string, number>()
  const scopeTypes = new Map<string, Set<string>>()

  for (const m of memories) {
    scopes.set(m.scope, (scopes.get(m.scope) || 0) + 1)
    types.set(m.type, (types.get(m.type) || 0) + 1)
    if (!scopeTypes.has(m.scope)) scopeTypes.set(m.scope, new Set())
    scopeTypes.get(m.scope)!.add(m.type)
  }

  const lines: string[] = []
  lines.push(`Total memories: ${memories.length}`)
  lines.push("")
  lines.push("Scopes:")
  for (const [scope, count] of [...scopes.entries()].sort((a, b) => b[1] - a[1])) {
    const typeList = [...scopeTypes.get(scope)!].join(", ")
    lines.push(`  ${scope}: ${count} (${typeList})`)
  }
  lines.push("")
  lines.push("Types:")
  for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type}: ${count}`)
  }

  return { content: lines.join("\n") }
}

const forget = async (input: unknown) => {
  const args = input as ForgetArgs
  const glob = new Bun.Glob("*.logfmt")
  const files = await Array.fromAsync(glob.scan(MEMORY_DIR))

  if (!files.length) return { content: "No memory files found" }

  let deleted = 0
  const deletedMemories: Memory[] = []

  for (const filename of files) {
    if (filename === "deletions.logfmt") continue // skip audit log
    const filepath = `${MEMORY_DIR}/${filename}`
    const file = Bun.file(filepath)
    const text = await file.text()
    const lines = text.split("\n")
    const filtered = lines.filter((line) => {
      const memory = parseLine(line)
      if (!memory) return true
      if (memory.scope === args.scope && memory.type === args.type) {
        deleted++
        deletedMemories.push(memory)
        return false
      }
      return true
    })
    if (filtered.length !== lines.length) {
      await Bun.write(filepath, filtered.join("\n"))
    }
  }

  // Log all deletions to audit file
  for (const memory of deletedMemories) {
    await logDeletion(memory, args.reason)
  }

  if (deleted === 0) return { content: `No memories found for ${args.type} in ${args.scope}` }
  return {
    content: `Deleted ${deleted} ${args.type} memory(s) from ${args.scope}. Reason: ${args.reason}\nDeletions logged to ${MEMORY_DIR}/deletions.logfmt`,
  }
}

export const MemoryPlugin = Plugin.define({
  id: "opencode-memory",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_remember",
        description: "Store a memory (decision, learning, preference, blocker, context, pattern)",
        input: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "Type of memory",
            },
            scope: { type: "string", description: "Scope/area (e.g., auth, api, mobile)" },
            content: { type: "string", description: "The memory content" },
            issue: { type: "string", description: "Related GitHub issue (e.g., #51)" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Additional tags",
            },
          },
          required: ["type", "scope", "content"],
          additionalProperties: false,
        },
        execute: (input) => remember(input),
      })

      editor.add({
        name: "memory_recall",
        description: "Retrieve memories by scope, type, or search query",
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Filter by scope" },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "Filter by type",
            },
            query: {
              type: "string",
              description: "Search term (space-separated words, matches any)",
            },
            limit: { type: "number", description: "Max results (default 20)" },
          },
          additionalProperties: false,
        },
        execute: (input) => recall(input),
      })

      editor.add({
        name: "memory_update",
        description:
          "Update an existing memory by scope and type (finds matching memory and updates its content)",
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope of memory to update" },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "Type of memory",
            },
            content: { type: "string", description: "The new content for the memory" },
            query: {
              type: "string",
              description: "Search term to find specific memory if multiple exist",
            },
            issue: { type: "string", description: "Update related GitHub issue (e.g., #51)" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Update tags",
            },
          },
          required: ["scope", "type", "content"],
          additionalProperties: false,
        },
        execute: (input) => update(input),
      })

      editor.add({
        name: "memory_forget",
        description:
          "Delete a memory by scope and type (removes matching lines from all memory files, logs deletion for audit)",
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope of memory to delete" },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "Type of memory",
            },
            reason: {
              type: "string",
              description: "Why this is being deleted (for audit purposes)",
            },
          },
          required: ["scope", "type", "reason"],
          additionalProperties: false,
        },
        execute: (input) => forget(input),
      })

      editor.add({
        name: "memory_list",
        description: "List all unique scopes and types in memory for discovery",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: () => listMemories(),
      })
    })
  },
})

export default MemoryPlugin
