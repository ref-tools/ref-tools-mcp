import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Parser, { SyntaxNode } from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Java from 'tree-sitter-java'
import Ruby from 'tree-sitter-ruby'
import C from 'tree-sitter-c'
import { typescript, tsx } from 'tree-sitter-typescript'

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
    language: typescript,
    chunkNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
    getName: nameFromCommonNode,
  },
  {
    name: 'tsx',
    exts: ['.tsx'],
    language: tsx,
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
  const source = fs.readFileSync(filePath, 'utf8')
  const parser = new Parser()
  parser.setLanguage(langCfg.language)
  const tree = parser.parse(source)

  const chunks: Chunk[] = []
  const parentStack: { node: SyntaxNode; chunkId: string }[] = []

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
        relations: parent ? [{ type: 'contains', targetId: id }] : [],
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
  const files = walkDir(rootDir, options.shouldIncludePath)
  const all: Chunk[] = []
  for (const abs of files) {
    const res = await chunkFile(abs, options)
    if (res && res.length) all.push(...res)
  }
  return all
}
