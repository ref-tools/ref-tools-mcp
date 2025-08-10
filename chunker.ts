import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ignore from 'ignore'
import Parser, { type SyntaxNode } from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Java from 'tree-sitter-java'
import Ruby from 'tree-sitter-ruby'
import C from 'tree-sitter-c'
import TS from 'tree-sitter-typescript'
import type { Annotation } from './searchdb'

export type Relation = {
  type: 'contains' | 'defines' | 'references'
  targetId: string
}

export type Chunk = {
  id: string
  filePath: string
  language: string
  type: string
  name?: string
  line: number
  endLine: number
  content: string
  contentHash: string
  parentId?: string
  relations: Relation[]
}

export type AnnotatedChunk = Chunk & Annotation

export type ChunkerOptions = {
  /**
   * Languages to enable. If omitted, a default set (js,ts,py,java,ruby,c) is used.
   */
  languages?: string[]
  /**
   * A predicate to skip certain paths (e.g., node_modules).
   */
  shouldIncludePath?: (absPath: string, relPath: string) => boolean
}

type LanguageConfig = {
  name: string
  exts: string[]
  language: any
  /** Node types that constitute a chunk for this language. */
  chunkNodeTypes: string[]
  /** Extract a human-friendly name from a chunk node. */
  getName: (node: SyntaxNode, source: string) => string | undefined
}

const LANGUAGES: LanguageConfig[] = [
  {
    name: 'javascript',
    exts: ['.js', '.mjs', '.cjs'],
    language: JavaScript,
    chunkNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
    getName: nameFromCommonNode,
  },
  {
    name: 'typescript',
    exts: ['.ts'],
    language: TS.typescript,
    chunkNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
    getName: nameFromCommonNode,
  },
  {
    name: 'tsx',
    exts: ['.tsx'],
    language: TS.tsx,
    chunkNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
    getName: nameFromCommonNode,
  },
  {
    name: 'python',
    exts: ['.py'],
    language: Python,
    chunkNodeTypes: ['function_definition', 'class_definition'],
    getName: (node) => childIdentifier(node),
  },
  {
    name: 'java',
    exts: ['.java'],
    language: Java,
    chunkNodeTypes: ['class_declaration', 'method_declaration', 'interface_declaration'],
    getName: (node, src) => {
      const id = node.childForFieldName('name')
      return id ? textOf(id, src) : undefined
    },
  },
  {
    name: 'ruby',
    exts: ['.rb'],
    language: Ruby,
    chunkNodeTypes: ['class', 'method'],
    getName: (node, src) => {
      const id = node.childForFieldName('name') || node.childForFieldName('method')
      return id ? textOf(id, src) : undefined
    },
  },
  {
    name: 'c',
    exts: ['.c', '.h'],
    language: C,
    chunkNodeTypes: ['function_definition'],
    getName: (node, src) => {
      // function_definition -> declarator -> function_declarator -> declarator(identifier)
      const id = node.descendantsOfType('identifier')[0]
      return id ? textOf(id, src) : undefined
    },
  },
]

function nameFromCommonNode(node: SyntaxNode, src: string): string | undefined {
  const id =
    node.childForFieldName('name') ||
    node.childForFieldName('method') ||
    node.childForFieldName('identifier') ||
    node.descendantsOfType('identifier')[0] ||
    node.descendantsOfType('property_identifier')[0]
  return id ? textOf(id, src) : undefined
}

function textOf(node: SyntaxNode, src: string) {
  return src.slice(node.startIndex, node.endIndex)
}

function childIdentifier(node: SyntaxNode): string | undefined {
  const id = node.childForFieldName('name') || node.descendantsOfType('identifier')[0]
  return id ? id.text : undefined
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function getLanguageForFile(filePath: string, enabled?: string[]): LanguageConfig | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return LANGUAGES.find((l) => (!enabled || enabled.includes(l.name)) && l.exts.includes(ext))
}

function walkDir(root: string, shouldInclude?: (abs: string, rel: string) => boolean): string[] {
  const out: string[] = []
  const stack: string[] = ['.']
  while (stack.length) {
    const rel = stack.pop()!
    const abs = path.join(root, rel)
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      for (const ent of fs.readdirSync(abs)) {
        const childRel = path.join(rel, ent)
        const childAbs = path.join(root, childRel)
        if (shouldInclude && !shouldInclude(childAbs, childRel)) continue
        // Skip common junk by default
        if (!shouldInclude && /(^|\/)node_modules(\/|$)/.test(childRel)) continue
        stack.push(childRel)
      }
    } else {
      out.push(abs)
    }
  }
  return out
}

export async function chunkFile(
  filePath: string,
  options: ChunkerOptions = {},
): Promise<Chunk[] | undefined> {
  const langCfg = getLanguageForFile(filePath, options.languages)
  if (!langCfg) return undefined
  const sourceRaw = fs.readFileSync(filePath, 'utf8')
  // Some parsers can throw on invalid inputs. Normalize minimally and fall back gracefully.
  const source = sourceRaw.replace(/\u0000/g, '')

  const chunks: Chunk[] = []

  const fileId = sha256Hex(`${path.resolve(filePath)}:file`)
  const fileChunk: Chunk = {
    id: fileId,
    filePath: path.resolve(filePath),
    language: langCfg.name,
    type: 'file',
    name: path.basename(filePath),
    line: 1,
    endLine: source.split('\n').length,
    content: source,
    contentHash: sha256Hex(source),
    relations: [],
  }
  chunks.push(fileChunk)

  let tree: { rootNode: SyntaxNode } | undefined
  try {
    const parser = new Parser()
    parser.setLanguage(langCfg.language)
    // tree-sitter may throw "Invalid argument" for certain inputs; catch and return file-only chunk
    tree = parser.parse(source) as unknown as { rootNode: SyntaxNode }
  } catch (e) {
    // console.error(`Failed to parse ${filePath}`, e)
    // Return only the file chunk if parsing fails
    return chunks
  }

  const parentStack: { node: SyntaxNode; chunkId: string }[] = []
  parentStack.push({ node: tree.rootNode, chunkId: fileId })

  const visit = (node: SyntaxNode) => {
    // If this node is a chunk boundary for this language
    if (langCfg.chunkNodeTypes.includes(node.type)) {
      const content = source.slice(node.startIndex, node.endIndex)
      const id = sha256Hex(`${fileChunk.filePath}:${node.startIndex}:${node.endIndex}`)
      const parent = parentStack[parentStack.length - 1]
      const chunk: Chunk = {
        id,
        filePath: fileChunk.filePath,
        language: langCfg.name,
        type: node.type,
        name: langCfg.getName(node, source),
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        content,
        contentHash: sha256Hex(content),
        parentId: parent?.chunkId,
        // Relations are recorded on the parent chunk only. The child should not
        // carry a self-referential CONTAINS edge. Parent->child edges are added
        // immediately below.
        relations: [],
      }
      // Attach relation on parent chunk
      const parentChunk = chunks.find((c) => c.id === parent?.chunkId)
      if (parentChunk) parentChunk.relations.push({ type: 'contains', targetId: id })
      chunks.push(chunk)
      parentStack.push({ node, chunkId: id })
    }

    // Recurse
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)!
      visit(child)
    }

    // Pop if we pushed
    const top = parentStack[parentStack.length - 1]
    if (top && top.node === node && top.chunkId !== fileId) {
      parentStack.pop()
    }
  }

  visit(tree.rootNode)

  // If no function/class etc. found, just return the file chunk
  return chunks
}

export async function chunkCodebase(
  rootDir: string,
  options: ChunkerOptions = {},
): Promise<Chunk[]> {
  // Compose a filter that honors .gitignore and any user-provided filter
  const gitignoreFile = path.join(rootDir, '.gitignore')
  let ig: ReturnType<typeof ignore> | undefined
  try {
    if (fs.existsSync(gitignoreFile)) {
      const giText = fs.readFileSync(gitignoreFile, 'utf8')
      ig = ignore()
      ig.add(giText)
    }
  } catch {
    // Best-effort: ignore failures reading .gitignore
  }

  const userFilter = options.shouldIncludePath
  const composedFilter = (absPath: string, relPath: string): boolean => {
    const relUnix = relPath.split(path.sep).join('/')
    // Always skip VCS dir
    if (/(^|\/)\.git(\/|$)/.test(relUnix)) return false
    // Apply .gitignore if present
    if (ig && ig.ignores(relUnix)) return false
    // Default skip for node_modules when no .gitignore rule provided
    if (!ig && /(^|\/)node_modules(\/|$)/.test(relUnix)) return false
    // Apply user filter last if provided
    if (userFilter && !userFilter(absPath, relPath)) return false
    return true
  }

  const files = walkDir(rootDir, composedFilter)
  const all: Chunk[] = []
  for (const abs of files) {
    // Skip files that are not of a supported language before attempting to read/parse
    if (!getLanguageForFile(abs, options.languages)) continue
    const res = await chunkFile(abs, options)
    if (res && res.length) all.push(...res)
  }
  return all
}
