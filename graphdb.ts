export type Properties = Record<string, any>
// Importing types only to avoid runtime coupling
import type { Chunk } from './chunker'

export type Node = {
  id: number
  labels: Set<string>
  properties: Properties
}

export type Relationship = {
  id: number
  type: string
  from: number
  to: number
  properties: Properties
}

type Binding = Record<string, any>

export class GraphDB {
  private nodes: Node[] = []
  private rels: Relationship[] = []
  private nextNodeId = 1
  private nextRelId = 1

  // Execute one or more Cypher statements separated by ';'
  run(cypher: string): any[] {
    const statements = this.splitStatements(cypher)
    let lastResult: any[] = []
    for (const stmt of statements) {
      const trimmed = stmt.trim()
      if (!trimmed) {
        console.log('skipping empty stmt')
        continue
      }
      // Hardcoded procedure support: CALL db.labels()
      if (/^CALL\s+db\.labels\(\)\s*$/i.test(trimmed)) {
        // Labels used by this custom graph: Chunk (all nodes), File (file nodes), Code (non-file code nodes)
        const labels = ['Chunk', 'Code', 'File']
        lastResult = labels.sort().map((label) => ({ label }))
        continue
      }
      let ast: Statement
      try {
        const parser = new Parser(trimmed)
        ast = parser.parseStatement()
      } catch (err: any) {
        // Log parse errors and rethrow
        console.error('Parse error:', err?.message || String(err), 'in statement:', trimmed)
        throw err
      }
      lastResult = this.execute(ast)
    }
    return lastResult
  }

  getAllNodes(): Node[] {
    return this.nodes.slice()
  }

  getAllRelationships(): Relationship[] {
    return this.rels.slice()
  }

  private splitStatements(input: string): string[] {
    // Split on semicolons that are not inside quotes
    const out: string[] = []
    let current = ''
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]
      if (ch === "'" && !inDouble) inSingle = !inSingle
      if (ch === '"' && !inSingle) inDouble = !inDouble
      if (ch === ';' && !inSingle && !inDouble) {
        out.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) out.push(current)
    return out
  }

  private execute(ast: Statement): any[] {
    switch (ast.kind) {
      case 'Create': {
        const scope: Record<string, Node | Relationship> = {}
        for (const pattern of ast.patterns) {
          this.instantiatePattern(pattern, scope)
        }
        if (ast.returnClause) {
          const bindings: Binding[] = [scope]
          let rows = this.applyWhere(bindings, ast.where)
          rows = this.project(rows, ast.returnClause)
          if (ast.returnClause.distinct) rows = distinctRows(rows)
          if (ast.returnClause.orderBy && ast.returnClause.orderBy.length > 0)
            rows = sortRows(rows, ast.returnClause.orderBy)
          if (ast.limit != null) rows = rows.slice(0, ast.limit)
          return rows
        }
        return []
      }
      case 'Match': {
        // Start with a single empty binding
        let bindings: Binding[] = [{}]
        for (const pattern of ast.patterns) {
          bindings = this.matchPattern(pattern, bindings)
        }
        bindings = this.applyWhere(bindings, ast.where)
        let rows = this.project(bindings, ast.returnClause)
        if (ast.returnClause?.distinct) rows = distinctRows(rows)
        if (ast.returnClause?.orderBy && ast.returnClause.orderBy.length > 0)
          rows = sortRows(rows, ast.returnClause.orderBy)
        if (ast.limit != null) rows = rows.slice(0, ast.limit)
        return rows
      }
      default:
        throw new Error('Unsupported statement')
    }
  }

  private instantiatePattern(pattern: Pattern, scope: Record<string, Node | Relationship>): void {
    if (pattern.kind === 'NodePattern') {
      const node = this.createNode(pattern.labels, pattern.props)
      if (pattern.variable) scope[pattern.variable] = node
      return
    }
    if (pattern.kind === 'RelPattern') {
      // Ensure endpoints exist (create if inline literal pattern specifies labels/props)
      const left = this.materializeNodeEndpoint(pattern.left, scope)
      const right = this.materializeNodeEndpoint(pattern.right, scope)
      const rel = this.createRelationship(
        left.id,
        right.id,
        pattern.relType || '',
        pattern.relProps,
      )
      if (pattern.relVar) scope[pattern.relVar] = rel
      // Bind endpoints if variables present
      if (pattern.left.variable) scope[pattern.left.variable] = left
      if (pattern.right.variable) scope[pattern.right.variable] = right
      return
    }
  }

  private materializeNodeEndpoint(
    nodePat: NodePattern,
    scope: Record<string, Node | Relationship>,
  ): Node {
    if (nodePat.variable && scope[nodePat.variable] && isNode(scope[nodePat.variable])) {
      return scope[nodePat.variable] as Node
    }
    // Create a new node for CREATE context
    return this.createNode(nodePat.labels, nodePat.props)
  }

  private createNode(labels: string[], props: Properties): Node {
    const node: Node = { id: this.nextNodeId++, labels: new Set(labels), properties: { ...props } }
    this.nodes.push(node)
    return node
  }

  private createRelationship(
    from: number,
    to: number,
    type: string,
    props: Properties,
  ): Relationship {
    const rel: Relationship = { id: this.nextRelId++, type, from, to, properties: { ...props } }
    this.rels.push(rel)
    return rel
  }

  private matchPattern(pattern: Pattern, inputBindings: Binding[]): Binding[] {
    if (pattern.kind === 'NodePattern') {
      const results: Binding[] = []
      for (const binding of inputBindings) {
        for (const node of this.nodes) {
          if (!matchNodeLiteral(node, pattern, binding)) continue
          if (pattern.variable && binding[pattern.variable] && binding[pattern.variable] !== node)
            continue
          const newBinding = { ...binding }
          if (pattern.variable) newBinding[pattern.variable] = node
          results.push(newBinding)
        }
      }
      return results
    } else if (pattern.kind === 'RelPattern') {
      const results: Binding[] = []
      for (const binding of inputBindings) {
        for (const rel of this.rels) {
          if (pattern.relType && pattern.relType !== rel.type) continue
          if (!propsMatch(rel.properties, pattern.relProps, binding)) continue
          const fromNode = this.getNodeById(rel.from)!
          const toNode = this.getNodeById(rel.to)!
          if (!matchNodeLiteral(fromNode, pattern.left, binding)) continue
          if (!matchNodeLiteral(toNode, pattern.right, binding)) continue
          // Respect existing bindings
          if (
            pattern.left.variable &&
            binding[pattern.left.variable] &&
            binding[pattern.left.variable] !== fromNode
          )
            continue
          if (
            pattern.right.variable &&
            binding[pattern.right.variable] &&
            binding[pattern.right.variable] !== toNode
          )
            continue
          if (pattern.relVar && binding[pattern.relVar] && binding[pattern.relVar] !== rel) continue
          const newBinding = { ...binding }
          if (pattern.left.variable) newBinding[pattern.left.variable] = fromNode
          if (pattern.right.variable) newBinding[pattern.right.variable] = toNode
          if (pattern.relVar) newBinding[pattern.relVar] = rel
          results.push(newBinding)
        }
      }
      return results
    }
    return inputBindings
  }

  private getNodeById(id: number): Node | undefined {
    return this.nodes.find((n) => n.id === id)
  }

  private applyWhere(bindings: Binding[], where?: Expr): Binding[] {
    if (!where) return bindings
    return bindings.filter((b) => truthy(evalExpr(where, b)))
  }

  private project(bindings: Binding[], ret?: ReturnClause): any[] {
    if (!ret) return bindings
    const rows: any[] = []
    if (ret.items.length === 1 && ret.items[0]!.kind === 'Agg') {
      const item = ret.items[0] as any
      if (item.agg.func === 'count') {
        if (item.agg.arg === '*') {
          const alias = item.alias || 'count'
          rows.push({ [alias]: bindings.length })
          return rows
        } else {
          const alias = item.alias || 'count'
          const v = item.agg.arg
          rows.push({ [alias]: bindings.filter((r) => r[v] != null).length })
          return rows
        }
      }
      if (item.agg.func === 'collect') {
        const v = item.agg.of.variable
        const values = bindings.map((b) => b[v])
        rows.push({ [item.alias || 'collect']: values })
        return rows
      }
    }
    for (const b of bindings) {
      const row: any = {}
      for (const item of ret.items) {
        const value =
          item.kind === 'Agg' ? aggregateValue(item, bindings) : resolveProjection(item, b)
        row[item.alias || itemToKey(item)] = value
      }
      rows.push(row)
    }
    return rows
  }
}

// A lightweight representation of the current in-memory graph suitable for visualization
export type GraphSnapshot = {
  nodes: Array<{
    id: number
    labels: string[]
    properties: Properties
  }>
  relationships: Array<{
    id: number
    type: string
    from: number
    to: number
    properties: Properties
  }>
}

// Extend GraphDB with a method to dump a terse view of the graph. This intentionally
// excludes any bulky fields like `content` if present in properties, while keeping
// enough metadata to render nodes/edges and tooltips.
export interface GraphDB {
  getGraph(): GraphSnapshot
}

GraphDB.prototype.getGraph = function getGraph(this: GraphDB): GraphSnapshot {
  const stripContent = (props: Properties): Properties => {
    if (!props) return {}
    // Omit any `content` key if present
    const { content, ...rest } = props as any
    return { ...rest }
  }

  return {
    nodes: (this as any).nodes.map((n: Node) => ({
      id: n.id,
      labels: Array.from(n.labels),
      properties: stripContent(n.properties),
    })),
    relationships: (this as any).rels.map((r: Relationship) => ({
      id: r.id,
      type: r.type,
      from: r.from,
      to: r.to,
      properties: stripContent(r.properties),
    })),
  }
}

// Helper: extract Chunk nodes from generic result rows using provided chunk catalog.
// This maps any returned node values (or arrays of nodes) with a 'Chunk' label
// to the corresponding full Chunk objects from `allChunks` (by matching `id`).
export function rowsToChunks(rows: any[], allChunks: Chunk[]): Chunk[] {
  const byId = new Map<string, Chunk>()
  const byFilePath = new Map<string, Chunk>()
  for (const c of allChunks) {
    byId.set(c.id, c)
    if (c.type === 'file') byFilePath.set(c.filePath, c)
  }
  const out: Chunk[] = []
  const seen = new Set<string>()

  const addChunk = (c: Chunk | undefined) => {
    if (c && !seen.has(c.id)) {
      seen.add(c.id)
      out.push(c)
    }
  }

  const consider = (val: any) => {
    if (val && typeof val === 'object') {
      // Node from GraphDB
      if ('labels' in val && 'properties' in val && val.properties && val.labels) {
        const labels = val.labels as Set<string>
        if (labels.has('Chunk')) {
          const id = String(val.properties.id || '')
          addChunk(id ? byId.get(id) : undefined)
        }
      }
      // Arrays (e.g., collect())
      else if (Array.isArray(val)) {
        for (const v of val) consider(v)
      }
      // Nested objects: scan shallowly
      else {
        for (const k of Object.keys(val)) consider((val as any)[k])
      }
    } else if (typeof val === 'string') {
      // Map returned filePath strings to the corresponding file chunk
      // This makes queries like `RETURN d.filePath` yield file chunks
      const byPath = byFilePath.get(val)
      if (byPath) addChunk(byPath)
      // Also allow raw chunk ids to map directly
      const byRawId = byId.get(val)
      if (byRawId) addChunk(byRawId)
    }
  }

  for (const r of rows) consider(r)
  return out
}

function isNode(x: any): x is Node {
  return x && typeof x === 'object' && 'labels' in x && 'properties' in x && 'id' in x
}

function matchNodeLiteral(node: Node, pat: NodePattern, binding: Binding): boolean {
  // Labels
  for (const lbl of pat.labels) {
    if (!node.labels.has(lbl)) return false
  }
  return propsMatch(node.properties, pat.props, binding)
}

function propsMatch(obj: Properties, required: Properties, binding: Binding): boolean {
  for (const k of Object.keys(required)) {
    const v = resolveRequiredValue(required[k], binding)
    if (!deepEquals(obj[k], v)) return false
  }
  return true
}

function resolveRequiredValue(v: any, binding: Binding): any {
  // Support property reference values inside inline property maps, e.g. { filePath: u.filePath }
  if (v && typeof v === 'object' && v.kind === 'PropRef') {
    const obj = binding[v.variable]
    return obj?.properties?.[v.property]
  }
  return v
}

function deepEquals(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!deepEquals(a[k], b[k])) return false
    }
    return true
  }
  return false
}

function truthy(v: any): boolean {
  return !!v
}

// AST definitions
type Statement =
  | {
      kind: 'Create'
      patterns: Pattern[]
      where?: Expr
      returnClause?: ReturnClause
      limit?: number
    }
  | {
      kind: 'Match'
      patterns: Pattern[]
      where?: Expr
      returnClause?: ReturnClause
      limit?: number
    }

type Pattern = NodePattern | RelPattern

type NodePattern = {
  kind: 'NodePattern'
  variable?: string
  labels: string[]
  props: Properties
}

type RelPattern = {
  kind: 'RelPattern'
  left: NodePattern
  right: NodePattern
  relVar?: string
  relType?: string
  relProps: Properties
}

type ReturnItem =
  | { kind: 'Var'; name: string; alias?: string; agg?: undefined }
  | { kind: 'Prop'; variable: string; property: string; alias?: string; agg?: undefined }
  | {
      kind: 'Agg'
      agg: { func: 'count'; arg: '*' | string } & { of?: { variable?: string } }
      alias?: string
    }
  | { kind: 'Agg'; agg: { func: 'collect' } & { of: { variable: string } }; alias?: string }
  | { kind: 'Func'; func: 'labels'; of: { variable: string }; alias?: string }

type OrderKey = { key: string }

type ReturnClause = { items: ReturnItem[]; distinct?: boolean; orderBy?: OrderKey[] }

type Expr =
  | { kind: 'Binary'; op: 'AND' | 'OR'; left: Expr; right: Expr }
  | { kind: 'Not'; expr: Expr }
  | {
      kind: 'Compare'
      op: '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' | 'ENDS WITH' | 'STARTS WITH' | 'CONTAINS'
      left: ValueExpr
      right: ValueExpr
    }
  | ValueExpr

type ValueExpr =
  | { kind: 'Literal'; value: any }
  | { kind: 'PropRef'; variable: string; property: string }

// ----------------- Parser -----------------
class Parser {
  private t: Tokenizer
  constructor(input: string) {
    this.t = new Tokenizer(input)
  }

  parseStatement(): Statement {
    if (this.t.peekIsKw('CREATE')) {
      this.t.expectKw('CREATE')
      const patterns = this.parsePatterns()
      let where: Expr | undefined
      let ret: ReturnClause | undefined
      let limit: number | undefined
      if (this.t.peekIsKw('WHERE')) {
        this.t.expectKw('WHERE')
        where = this.parseExpr()
      }
      if (this.t.peekIsKw('RETURN')) {
        ret = this.parseReturn()
      }
      if (this.t.peekIsKw('ORDER')) {
        // ORDER BY after RETURN
        const orderBy = this.parseOrderBy()
        if (ret) ret.orderBy = orderBy
      }
      if (this.t.peekIsKw('LIMIT')) {
        this.t.expectKw('LIMIT')
        limit = this.parseNumber()
      }
      this.t.expectEOF()
      return { kind: 'Create', patterns, where, returnClause: ret, limit }
    }
    if (this.t.peekIsKw('MATCH')) {
      this.t.expectKw('MATCH')
      const patterns = this.parsePatterns()
      let where: Expr | undefined
      let ret: ReturnClause | undefined
      let limit: number | undefined
      if (this.t.peekIsKw('WHERE')) {
        this.t.expectKw('WHERE')
        where = this.parseExpr()
      }
      if (this.t.peekIsKw('RETURN')) {
        ret = this.parseReturn()
      }
      if (this.t.peekIsKw('ORDER')) {
        const orderBy = this.parseOrderBy()
        if (ret) ret.orderBy = orderBy
      }
      if (this.t.peekIsKw('LIMIT')) {
        this.t.expectKw('LIMIT')
        limit = this.parseNumber()
      }
      this.t.expectEOF()
      return { kind: 'Match', patterns, where, returnClause: ret, limit }
    }
    throw this.t.error('Expected CREATE or MATCH')
  }

  private parsePatterns(): Pattern[] {
    const patterns: Pattern[] = []
    // parse one or more pattern groups separated by commas
    for (;;) {
      const group = this.parsePatternGroup()
      for (const p of group) patterns.push(p)
      if (!this.t.peekSymbol(',')) break
      this.t.next()
    }
    return patterns
  }

  // Parse a single pattern group which may contain a node-only pattern or
  // a chain of one or more relationships. Returns one or more Pattern items.
  private parsePatternGroup(): Pattern[] {
    const out: Pattern[] = []
    let left = this.parseNodePattern()
    // Loop to support multi-hop chains: (a)-[...]->(b)-[...]->(c)
    while (this.t.peekSymbol('-')) {
      this.t.expectSymbol('-')
      this.t.expectSymbol('[')
      let relVar: string | undefined
      let relType: string | undefined
      let relProps: Properties = {}
      if (this.t.peekIdent()) {
        // could be var or :TYPE
        const ident = this.t.readIdent()
        if (this.t.peekSymbol(':')) {
          relVar = ident
          this.t.expectSymbol(':')
          relType = this.t.readIdentOrKeyword()
        } else if (ident.toUpperCase() === ident) {
          // TYPE in all-caps
          relType = ident
        } else {
          relVar = ident
        }
      }
      if (this.t.peekSymbol(':') && !relType) {
        this.t.expectSymbol(':')
        relType = this.t.readIdentOrKeyword()
      }
      if (this.t.peekSymbol('{')) {
        relProps = this.parseProps()
      }
      this.t.expectSymbol(']')
      // Support either '-' then '>' or a single '->' token
      if (this.t.peekSymbol('->')) {
        this.t.next()
      } else {
        this.t.expectSymbol('-')
        this.t.expectSymbol('>')
      }
      const right = this.parseNodePattern()
      out.push({ kind: 'RelPattern', left, right, relVar, relType, relProps })
      // advance chain: next hop starts from the right node
      left = right
    }
    // If no relationships parsed, emit the standalone node pattern
    if (out.length === 0) out.push(left)
    return out
  }

  private parseNodePattern(): NodePattern {
    this.t.expectSymbol('(')
    let variable: string | undefined
    const labels: string[] = []
    let props: Properties = {}
    if (this.t.peekIdent()) {
      variable = this.t.readIdent()
    }
    while (this.t.peekSymbol(':')) {
      this.t.expectSymbol(':')
      labels.push(this.t.readIdent())
    }
    if (this.t.peekSymbol('{')) {
      props = this.parseProps()
    }
    this.t.expectSymbol(')')
    return { kind: 'NodePattern', variable, labels, props }
  }

  private parseProps(): Properties {
    const obj: Properties = {}
    this.t.expectSymbol('{')
    if (!this.t.peekSymbol('}')) {
      while (true) {
        const key = this.t.readIdent()
        this.t.expectSymbol(':')
        obj[key] = this.parsePropValue()
        if (this.t.peekSymbol('}')) break
        this.t.expectSymbol(',')
      }
    }
    this.t.expectSymbol('}')
    return obj
  }

  // Parse a literal value or a property reference (e.g., u.filePath) inside inline property maps
  private parsePropValue(): any {
    if (this.t.peekString()) return this.t.readString()
    if (this.t.peekNumber()) return this.parseNumber()
    if (this.t.peekSymbol('{')) return this.parseProps()
    if (this.t.peekIsKw('TRUE')) {
      this.t.expectKw('TRUE')
      return true
    }
    if (this.t.peekIsKw('FALSE')) {
      this.t.expectKw('FALSE')
      return false
    }
    if (this.t.peekIsKw('NULL')) {
      this.t.expectKw('NULL')
      return null
    }
    // identifier or property reference
    const ident = this.t.readIdent()
    if (this.t.peekSymbol('.')) {
      this.t.expectSymbol('.')
      const prop = this.t.readIdent()
      return { kind: 'PropRef', variable: ident, property: prop }
    }
    return ident
  }

  private parseReturn(): ReturnClause {
    this.t.expectKw('RETURN')
    let distinct = false
    if (this.t.peekIsKw('DISTINCT')) {
      this.t.expectKw('DISTINCT')
      distinct = true
    }
    const items: ReturnItem[] = []
    items.push(this.parseReturnItem())
    while (this.t.peekSymbol(',')) {
      this.t.next()
      items.push(this.parseReturnItem())
    }
    return { items, distinct }
  }

  private parseOrderBy(): OrderKey[] {
    this.t.expectKw('ORDER')
    this.t.expectKw('BY')
    const keys: OrderKey[] = []
    keys.push({ key: this.parseOrderKey() })
    while (this.t.peekSymbol(',')) {
      this.t.next()
      keys.push({ key: this.parseOrderKey() })
    }
    return keys
  }

  private parseOrderKey(): string {
    const ident = this.t.readIdent()
    let key = ident
    if (this.t.peekSymbol('.')) {
      this.t.expectSymbol('.')
      key = `${ident}.${this.t.readIdent()}`
    }
    // Optional ASC/DESC ignored for now
    if (this.t.peekIsKw('ASC')) this.t.expectKw('ASC')
    else if (this.t.peekIsKw('DESC')) this.t.expectKw('DESC')
    return key
  }

  private parseReturnItem(): ReturnItem {
    if (this.t.peekIsKw('COUNT')) {
      this.t.expectKw('COUNT')
      this.t.expectSymbol('(')
      if (this.t.peekSymbol('*')) {
        this.t.expectSymbol('*')
        this.t.expectSymbol(')')
        const alias = this.parseOptionalAlias()
        return { kind: 'Agg', agg: { func: 'count', arg: '*', of: {} }, alias }
      } else {
        const varName = this.t.readIdent()
        this.t.expectSymbol(')')
        const alias = this.parseOptionalAlias()
        return {
          kind: 'Agg',
          agg: { func: 'count', arg: varName, of: { variable: varName } },
          alias,
        }
      }
    }
    if (this.t.peekIsKw('COLLECT')) {
      this.t.expectKw('COLLECT')
      this.t.expectSymbol('(')
      const varName = this.t.readIdent()
      this.t.expectSymbol(')')
      const alias = this.parseOptionalAlias()
      return { kind: 'Agg', agg: { func: 'collect', of: { variable: varName } }, alias }
    }
    const ident = this.t.readIdent()
    // Support function-style projections like labels(n)
    if (this.t.peekSymbol('(')) {
      this.t.expectSymbol('(')
      const varName = this.t.readIdent()
      this.t.expectSymbol(')')
      const alias = this.parseOptionalAlias()
      const func = ident.toLowerCase()
      if (func === 'labels') {
        return { kind: 'Func', func: 'labels', of: { variable: varName }, alias }
      }
      throw this.t.error(`Unsupported function ${ident}`)
    }
    if (this.t.peekSymbol('.')) {
      this.t.expectSymbol('.')
      const prop = this.t.readIdent()
      const alias = this.parseOptionalAlias()
      return { kind: 'Prop', variable: ident, property: prop, alias }
    } else {
      const alias = this.parseOptionalAlias()
      return { kind: 'Var', name: ident, alias }
    }
  }

  private parseOptionalAlias(): string | undefined {
    if (this.t.peekIsKw('AS')) {
      this.t.expectKw('AS')
      // Allow keywords to be used as alias names (e.g., AS count)
      return this.t.readIdentOrKeywordAsName()
    }
    return undefined
  }

  private parseExpr(): Expr {
    return this.parseOr()
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.t.peekIsKw('OR')) {
      this.t.expectKw('OR')
      const right = this.parseAnd()
      left = { kind: 'Binary', op: 'OR', left, right }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseNot()
    while (this.t.peekIsKw('AND')) {
      this.t.expectKw('AND')
      const right = this.parseNot()
      left = { kind: 'Binary', op: 'AND', left, right }
    }
    return left
  }

  private parseNot(): Expr {
    if (this.t.peekIsKw('NOT')) {
      this.t.expectKw('NOT')
      return { kind: 'Not', expr: this.parsePrimaryExpr() }
    }
    return this.parsePrimaryExpr()
  }

  private parsePrimaryExpr(): Expr {
    if (this.t.peekSymbol('(')) {
      this.t.expectSymbol('(')
      const e = this.parseExpr()
      this.t.expectSymbol(')')
      return e
    }
    const left = this.parseValueExpr()
    if (this.t.peekCompareOp()) {
      const op = this.t.readCompareOp() as Expr['kind'] extends never ? never : any
      const right = this.parseValueExpr()
      return { kind: 'Compare', op, left, right }
    }
    // Support string operators: ENDS WITH, STARTS WITH, CONTAINS
    if (this.t.peekIsKw('ENDS')) {
      this.t.expectKw('ENDS')
      this.t.expectKw('WITH')
      const right = this.parseValueExpr()
      return { kind: 'Compare', op: 'ENDS WITH', left, right }
    }
    if (this.t.peekIsKw('STARTS')) {
      this.t.expectKw('STARTS')
      this.t.expectKw('WITH')
      const right = this.parseValueExpr()
      return { kind: 'Compare', op: 'STARTS WITH', left, right }
    }
    if (this.t.peekIsKw('CONTAINS')) {
      this.t.expectKw('CONTAINS')
      const right = this.parseValueExpr()
      return { kind: 'Compare', op: 'CONTAINS', left, right }
    }
    return left
  }

  private parseValueExpr(): ValueExpr {
    if (this.t.peekString()) {
      return { kind: 'Literal', value: this.t.readString() }
    }
    if (this.t.peekNumber()) {
      return { kind: 'Literal', value: this.parseNumber() }
    }
    // prop ref or bare identifier literal not supported; treat as propref
    const ident = this.t.readIdent()
    if (this.t.peekSymbol('.')) {
      this.t.expectSymbol('.')
      const prop = this.t.readIdent()
      return { kind: 'PropRef', variable: ident, property: prop }
    }
    // Fallback literal string of identifier
    return { kind: 'Literal', value: ident }
  }

  private parseValue(): any {
    if (this.t.peekString()) return this.t.readString()
    if (this.t.peekNumber()) return this.parseNumber()
    if (this.t.peekSymbol('{')) return this.parseProps() // nested object literal
    if (this.t.peekIsKw('TRUE')) {
      this.t.expectKw('TRUE')
      return true
    }
    if (this.t.peekIsKw('FALSE')) {
      this.t.expectKw('FALSE')
      return false
    }
    if (this.t.peekIsKw('NULL')) {
      this.t.expectKw('NULL')
      return null
    }
    // identifier literal, e.g., enums
    return this.t.readIdent()
  }

  private parseNumber(): number {
    const n = this.t.readNumber()
    return n
  }
}

// ----------------- Tokenizer -----------------
type Tok =
  | { type: 'ident'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'kw'; value: string }
  | { type: 'eof' }

class Tokenizer {
  private tokens: Tok[]
  constructor(private input: string) {
    this.tokens = this.lex()
  }

  private lex(): Tok[] {
    const t: Tok[] = []
    const s = this.input
    const push = (tok: Tok) => t.push(tok)
    const isAlpha = (c: string) => /[A-Za-z_]/.test(c)
    const isAlnum = (c: string) => /[A-Za-z0-9_]/.test(c)
    const symbols = new Set([
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      ',',
      ':',
      '.',
      '-',
      '>',
      '<',
      '=',
      '!',
      '*',
    ])
    let i = 0
    while (i < s.length) {
      const ch = s.charAt(i)
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i++
        continue
      }
      if (ch === '/' && s.charAt(i + 1) === '/') {
        // line comment
        while (i < s.length && s.charAt(i) !== '\n') i++
        continue
      }
      if (ch === "'" || ch === '"') {
        const quote = ch
        i++
        let str = ''
        while (i < s.length) {
          const c = s.charAt(i)
          if (c === '\\') {
            const next = s.charAt(i + 1)
            const map: Record<string, string> = {
              n: '\n',
              r: '\r',
              t: '\t',
              '\\': '\\',
              '"': '"',
              "'": "'",
            }
            if (map[next] !== undefined) {
              str += map[next]
              i += 2
              continue
            }
          }
          if (c === quote) {
            i++
            break
          }
          str += c
          i++
        }
        push({ type: 'string', value: str })
        continue
      }
      if (isAlpha(ch)) {
        let id = ch
        i++
        while (i < s.length && isAlnum(s.charAt(i))) {
          id += s.charAt(i)
          i++
        }
        const kw = id.toUpperCase()
        switch (kw) {
          case 'CREATE':
          case 'MATCH':
          case 'WHERE':
          case 'RETURN':
          case 'DISTINCT':
          case 'ORDER':
          case 'BY':
          case 'LIMIT':
          case 'AND':
          case 'OR':
          case 'NOT':
          case 'COUNT':
          case 'COLLECT':
          case 'AS':
          case 'ASC':
          case 'DESC':
          case 'TRUE':
          case 'FALSE':
          case 'NULL':
          case 'ENDS':
          case 'STARTS':
          case 'WITH':
          case 'CONTAINS':
            push({ type: 'kw', value: kw })
            break
          default:
            push({ type: 'ident', value: id })
        }
        continue
      }
      if (/[0-9]/.test(ch)) {
        let num = ch
        i++
        while (i < s.length && /[0-9_]/.test(s.charAt(i))) {
          num += s.charAt(i)
          i++
        }
        if (s.charAt(i) === '.' && /[0-9]/.test(s.charAt(i + 1))) {
          num += s.charAt(i++)
          while (i < s.length && /[0-9_]/.test(s.charAt(i))) {
            num += s.charAt(i)
            i++
          }
        }
        push({ type: 'number', value: Number(num.replace(/_/g, '')) })
        continue
      }
      if (symbols.has(ch)) {
        // two-char operators
        const two = ch + s.charAt(i + 1)
        if (
          two === '->' ||
          two === '<-' ||
          two === '<=' ||
          two === '>=' ||
          two === '!=' ||
          two === '<>'
        ) {
          push({ type: 'symbol', value: two })
          i += 2
          continue
        }
        // three-char not needed currently
        push({ type: 'symbol', value: ch })
        i++
        continue
      }
      throw new Error(`Unexpected character: ${ch}`)
    }
    t.push({ type: 'eof' })
    return t
  }

  private idx = 0
  private tok(): Tok {
    return this.tokens[this.idx] ?? { type: 'eof' }
  }
  private advance() {
    this.idx++
  }
  error(msg: string): Error {
    return new Error(msg)
  }
  next(): Tok {
    const cur = this.tok()
    this.advance()
    return cur
  }
  peekSymbol(sym: string): boolean {
    const t = this.tok()
    return t.type === 'symbol' && t.value === sym
  }
  expectSymbol(sym: string) {
    const t = this.next()
    if (t.type !== 'symbol' || t.value !== sym) throw this.error(`Expected symbol '${sym}'`)
  }
  peekIdent(): boolean {
    return this.tok().type === 'ident'
  }
  readIdent(): string {
    const t = this.next()
    if (t.type !== 'ident') throw this.error('Expected identifier')
    return t.value
  }
  // Allow reading either a regular identifier token or a keyword as a name
  // Useful for relationship TYPE tokens that may be written as uppercase words
  readIdentOrKeyword(): string {
    const t = this.next()
    if (t.type === 'ident') return t.value
    if (t.type === 'kw') return t.value
    throw this.error('Expected identifier')
  }
  peekIsKw(kw: string): boolean {
    const t = this.tok()
    return t.type === 'kw' && t.value === kw
  }
  expectKw(kw: string) {
    const t = this.next()
    if (t.type !== 'kw' || t.value !== kw) throw this.error(`Expected keyword ${kw}`)
  }
  peekString(): boolean {
    return this.tok().type === 'string'
  }
  readString(): string {
    const t = this.next()
    if (t.type !== 'string') throw this.error('Expected string')
    return t.value
  }
  peekNumber(): boolean {
    return this.tok().type === 'number'
  }
  readNumber(): number {
    const t = this.next()
    if (t.type !== 'number') throw this.error('Expected number')
    return t.value
  }
  // Accept either an identifier or a keyword token as a name (for aliases)
  readIdentOrKeywordAsName(): string {
    const t = this.next()
    if (t.type === 'ident') return t.value
    if (t.type === 'kw') return t.value.toLowerCase()
    throw this.error('Expected identifier')
  }
  peekCompareOp(): boolean {
    const t = this.tok()
    return (
      t.type === 'symbol' &&
      (t.value === '=' ||
        t.value === '<>' ||
        t.value === '<' ||
        t.value === '<=' ||
        t.value === '>' ||
        t.value === '>=' ||
        t.value === '!=')
    )
  }
  readCompareOp(): string {
    const t = this.next()
    if (t.type !== 'symbol') throw this.error('Expected comparison operator')
    return t.value
  }
  expectEOF() {
    const t = this.tok()
    if (t.type !== 'eof') throw this.error('Unexpected trailing input')
  }
}

// ----------------- Evaluation helpers -----------------
function resolveProjection(item: ReturnItem, binding: Binding): any {
  switch (item.kind) {
    case 'Var':
      return binding[item.name]
    case 'Prop': {
      const obj = binding[item.variable]
      if (!obj) return undefined
      return obj.properties?.[item.property]
    }
    case 'Func': {
      if (item.func === 'labels') {
        const obj = binding[item.of.variable]
        if (!obj) return undefined
        if (isNode(obj)) return Array.from(obj.labels)
        return undefined
      }
      return undefined
    }
    case 'Agg':
      throw new Error('Internal error: aggregate should be pre-handled')
  }
}

function itemToKey(item: ReturnItem): string {
  switch (item.kind) {
    case 'Var':
      return item.name
    case 'Prop':
      return `${item.variable}.${item.property}`
    case 'Agg':
      if (item.agg.func === 'count') return 'count'
      if (item.agg.func === 'collect') return 'collect'
      return 'agg'
    case 'Func':
      if (item.func === 'labels') return 'labels'
      return item.func
  }
}

function aggregateValue(item: ReturnItem, rows: Binding[]): any {
  if (item.kind !== 'Agg') return undefined
  if (item.agg.func === 'count') {
    if (item.agg.arg === '*') return rows.length
    // count of variable present (non-null)
    const v = item.agg.arg
    return rows.filter((r) => r[v] != null).length
  }
  if (item.agg.func === 'collect') {
    // collect variable bindings
    const v = (item.agg as any).of.variable
    return rows.map((r) => r[v])
  }
}

function evalExpr(expr: Expr, binding: Binding): any {
  switch (expr.kind) {
    case 'Literal':
      return expr.value
    case 'PropRef': {
      const v = binding[expr.variable]
      if (!v) return undefined
      return v.properties?.[expr.property]
    }
    case 'Not':
      return !truthy(evalExpr(expr.expr, binding))
    case 'Binary': {
      const l = truthy(evalExpr(expr.left, binding))
      if (expr.op === 'AND') return l && truthy(evalExpr(expr.right, binding))
      if (expr.op === 'OR') return l || truthy(evalExpr(expr.right, binding))
      return false
    }
    case 'Compare': {
      const l = valueOf(expr.left, binding)
      const r = valueOf(expr.right, binding)
      switch (expr.op) {
        case '=':
          return deepEquals(l, r)
        case '!=':
        case '<>':
          return !deepEquals(l, r)
        case '<':
          return (l as any) < (r as any)
        case '<=':
          return (l as any) <= (r as any)
        case '>':
          return (l as any) > (r as any)
        case '>=':
          return (l as any) >= (r as any)
        case 'ENDS WITH':
          return typeof (l as any) === 'string' && typeof (r as any) === 'string'
            ? (l as any).endsWith(r as any)
            : false
        case 'STARTS WITH':
          return typeof (l as any) === 'string' && typeof (r as any) === 'string'
            ? (l as any).startsWith(r as any)
            : false
        case 'CONTAINS':
          return typeof (l as any) === 'string' && typeof (r as any) === 'string'
            ? (l as any).includes(r as any)
            : false
        default:
          return false
      }
    }
  }
}

function valueOf(v: ValueExpr, binding: Binding): any {
  if (v.kind === 'Literal') return v.value
  if (v.kind === 'PropRef') {
    const obj = binding[v.variable]
    return obj?.properties?.[v.property]
  }
}

// ----------------- Post-projection helpers -----------------
function stableRowKey(row: any): string {
  const keys = Object.keys(row).sort()
  const parts: string[] = []
  for (const k of keys) {
    parts.push(k)
    const v = row[k]
    // Only support primitives in DISTINCT keys; for objects, fall back to JSON
    if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      parts.push(String(v))
    } else {
      try {
        parts.push(JSON.stringify(v))
      } catch {
        parts.push(String(v))
      }
    }
  }
  return parts.join('|')
}

function distinctRows(rows: any[]): any[] {
  const seen = new Set<string>()
  const out: any[] = []
  for (const r of rows) {
    const key = stableRowKey(r)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

function sortRows(rows: any[], orderBy: { key: string }[]): any[] {
  const keys = orderBy.map((k) => k.key)
  const copy = rows.slice()
  copy.sort((a, b) => {
    for (const k of keys) {
      const av = a[k]
      const bv = b[k]
      if (av === bv) continue
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv)
      if (typeof av === 'number' && typeof bv === 'number') return av - bv
      // Fallback string comparison
      return String(av).localeCompare(String(bv))
    }
    return 0
  })
  return copy
}
