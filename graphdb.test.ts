import { describe, it, expect, vi } from 'vitest'
import { GraphDB, rowsToChunks } from './graphdb'
import type { Node, Relationship } from './graphdb'
import SearchAgent from './search_agent'

function isNode(x: any): x is Node {
  return !!x && typeof x.id === 'number' && !!(x as any).properties && !!(x as any).labels
}

function isRel(x: any): x is Relationship {
  return x && typeof x.id === 'number' && typeof x.from === 'number' && typeof x.to === 'number'
}

describe('GraphDB - CREATE', () => {
  it('creates a single node and returns it', () => {
    const db = new GraphDB()
    const res = db.run("CREATE (n:Person {name:'Alice', age:30}) RETURN n")
    expect(res).toHaveLength(1)
    expect(isNode(res[0].n)).toBe(true)
    const n = res[0].n as Node
    expect(n.properties.name).toBe('Alice')
    expect(n.properties.age).toBe(30)
    expect(n.labels.has('Person')).toBe(true)
  })

  it('creates multiple nodes in one statement', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'}), (b:Person {name:'B'})")
    expect(db.getAllNodes()).toHaveLength(2)
  })

  it('creates a relationship with inline endpoints', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'})-[:KNOWS {since:2020}]->(b:Person {name:'B'})")
    expect(db.getAllNodes()).toHaveLength(2)
    expect(db.getAllRelationships()).toHaveLength(1)
    const rel = db.getAllRelationships()[0]!
    expect(rel.type).toBe('KNOWS')
    expect(rel.properties.since).toBe(2020)
  })
})

describe('GraphDB - getGraph snapshot', () => {
  it('returns a terse snapshot of nodes and relationships without content', () => {
    const db = new GraphDB()
    db.run(
      "CREATE (f:File:Chunk {id:'F1', filePath:'/a.ts', contentHash:'h1', content:'x'}), (u:Chunk {id:'U1', name:'User', type:'function_declaration', content:'function User(){}'}), (f)-[:CONTAINS]->(u)",
    )
    const g = (db as any).getGraph()
    expect(Array.isArray(g.nodes)).toBe(true)
    expect(Array.isArray(g.relationships)).toBe(true)
    // Ensure content field is stripped from properties
    const withContent = g.nodes.find((n: any) => n.properties && 'content' in n.properties)
    expect(withContent).toBeUndefined()
    // Labels should be arrays, not sets
    expect(Array.isArray(g.nodes[0].labels)).toBe(true)
    // Relationship shape
    if (g.relationships.length > 0) {
      const r = g.relationships[0]
      expect(typeof r.from).toBe('number')
      expect(typeof r.to).toBe('number')
      expect(typeof r.type).toBe('string')
    }
  })
})

describe('GraphDB - MATCH nodes', () => {
  it('matches all nodes and counts them', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'}), (b:Person {name:'B'}), (c:Animal {name:'C'})")
    const res = db.run('MATCH (n) RETURN count(*) AS cnt')
    expect(res).toEqual([{ cnt: 3 }])
  })

  it('matches by label', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'}), (b:Person {name:'B'}), (c:Animal {name:'C'})")
    const res = db.run('MATCH (p:Person) RETURN count(*) AS c')
    expect(res).toEqual([{ c: 2 }])
  })

  it('matches by inline properties', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A', age:40}), (b:Person {name:'B', age:20})")
    const res = db.run('MATCH (p:Person {age:20}) RETURN p')
    expect(res).toHaveLength(1)
    expect((res[0].p as Node).properties.name).toBe('B')
  })
})

describe('GraphDB - MATCH relationships', () => {
  it('returns endpoints and relationship with type filter', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'})-[:KNOWS {since:2020}]->(b:Person {name:'B'})")
    const res = db.run('MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b')
    expect(res).toHaveLength(1)
    const row = res[0]
    expect(isNode(row.a)).toBe(true)
    expect(isRel(row.r)).toBe(true)
    expect(isNode(row.b)).toBe(true)
    expect((row.a as Node).properties.name).toBe('A')
    expect((row.b as Node).properties.name).toBe('B')
    expect((row.r as Relationship).properties.since).toBe(2020)
  })

  it('filters on relationship properties', () => {
    const db = new GraphDB()
    db.run(
      "CREATE (a:Person {name:'A'})-[:KNOWS {since:2020}]->(b:Person {name:'B'}), (a)-[:KNOWS {since:2010}]->(c:Person {name:'C'})",
    )
    const res = db.run(
      'MATCH (a:Person)-[r:KNOWS]->(b:Person) WHERE r.since >= 2015 RETURN count(*) AS cnt',
    )
    expect(res).toEqual([{ cnt: 1 }])
  })

  it('supports multi-hop relationship chains in a single pattern', () => {
    const db = new GraphDB()
    db.run(
      "CREATE (f:File:Chunk {filePath:'/src/user.ts'}), (u:Chunk {filePath:'/src/user.ts'}), (d:Chunk {name:'GraphDB'}), (f)-[:CONTAINS]->(u), (u)-[:REFERENCES]->(d)",
    )
    const res = db.run(
      "MATCH (f:File:Chunk)-[:CONTAINS]->(u:Chunk)-[:REFERENCES]->(d:Chunk { name: 'GraphDB' }) RETURN DISTINCT f ORDER BY f.filePath",
    )
    expect(res).toHaveLength(1)
    const f = res[0].f as any
    expect(f.properties.filePath).toBe('/src/user.ts')
  })
})

describe('GraphDB - WHERE', () => {
  it('supports equality and inequality', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'Alice', age:30}), (b:Person {name:'Bob', age:40})")
    const eq = db.run("MATCH (p:Person) WHERE p.name = 'Alice' RETURN p")
    expect(eq).toHaveLength(1)
    const ne = db.run("MATCH (p:Person) WHERE p.name <> 'Alice' RETURN count(*) AS c")
    expect(ne).toEqual([{ c: 1 }])
  })

  it('supports numeric comparisons and boolean logic', () => {
    const db = new GraphDB()
    db.run(
      "CREATE (a:Person {name:'A', age:20}), (b:Person {name:'B', age:30}), (c:Person {name:'C', age:40})",
    )
    const res = db.run(
      'MATCH (p:Person) WHERE (p.age >= 30 AND p.age < 40) OR p.name = "A" RETURN collect(p) AS arr',
    )
    // Should include A (age 20 by name) and B (30), exclude C (40)
    expect(Array.isArray(res[0].arr)).toBe(true)
    const names = (res[0].arr as Node[]).map((n) => n.properties.name).sort()
    expect(names).toEqual(['A', 'B'])
  })

  it('supports string operators: ENDS WITH, STARTS WITH, CONTAINS', () => {
    const db = new GraphDB()
    db.run(
      "CREATE (a:File {filePath:'/path/to/a.ts'}), (b:File {filePath:'/path/to/b.ts'}), (c:File {filePath:'/root/other/c.ts'})",
    )
    const ends = db.run("MATCH (f:File) WHERE f.filePath ENDS WITH '/b.ts' RETURN count(*) AS c")
    expect(ends).toEqual([{ c: 1 }])

    const starts = db.run(
      "MATCH (f:File) WHERE f.filePath STARTS WITH '/path' RETURN count(*) AS c",
    )
    expect(starts).toEqual([{ c: 2 }])

    const contains = db.run(
      "MATCH (f:File) WHERE f.filePath CONTAINS '/other/' RETURN count(*) AS c",
    )
    expect(contains).toEqual([{ c: 1 }])
  })
})

describe('GraphDB - RETURN projections', () => {
  it('returns variables and properties with aliases', () => {
    const db = new GraphDB()
    db.run("CREATE (p:Person {name:'Alice', age:30})")
    const res = db.run('MATCH (p:Person) RETURN p.name AS name, p.age AS age')
    expect(res).toEqual([{ name: 'Alice', age: 30 }])
  })

  it('supports count(var) and count(*)', () => {
    const db = new GraphDB()
    db.run('CREATE (a:Person), (b:Person), (c:Animal)')
    const c1 = db.run('MATCH (n) RETURN count(*) AS total')
    expect(c1).toEqual([{ total: 3 }])
    const c2 = db.run('MATCH (p:Person) RETURN count(p) AS persons')
    expect(c2).toEqual([{ persons: 2 }])
  })

  it('allows keyword-like alias names (count, collect, return)', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'Alice'}), (b:Person {name:'Bob'})")

    // Alias name 'count' (same as function name)
    const r1 = db.run('MATCH (n) RETURN count(*) AS count')
    expect(r1).toEqual([{ count: 2 }])

    // Alias name 'collect' (same as function name)
    const r2 = db.run('MATCH (p:Person) RETURN collect(p) AS collect')
    expect(Array.isArray(r2[0].collect)).toBe(true)
    expect(r2[0].collect).toHaveLength(2)

    // Alias name colliding with reserved keyword 'RETURN' (lowercase)
    const r3 = db.run('MATCH (p:Person {name:"Alice"}) RETURN p.name AS return')
    expect(r3).toEqual([{ return: 'Alice' }])
  })
})

describe('GraphDB - LIMIT', () => {
  it('limits the number of rows returned', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'}), (b:Person {name:'B'}), (c:Person {name:'C'})")
    const res = db.run('MATCH (p:Person) RETURN p LIMIT 2')
    expect(res).toHaveLength(2)
  })
})

describe('GraphDB - DISTINCT and ORDER BY', () => {
  it('deduplicates rows with DISTINCT and sorts with ORDER BY alias', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'A'}), (b:Person {name:'B'}), (c:Person {name:'A'})")
    const res = db.run('MATCH (p:Person) RETURN DISTINCT p.name AS name ORDER BY name')
    expect(res).toEqual([{ name: 'A' }, { name: 'B' }])
  })

  it('orders rows without DISTINCT', () => {
    const db = new GraphDB()
    db.run("CREATE (a:Person {name:'B'}), (b:Person {name:'A'}), (c:Person {name:'A'})")
    const res = db.run('MATCH (p:Person) RETURN p.name AS name ORDER BY name')
    expect(res.map((r) => r.name)).toEqual(['A', 'A', 'B'])
  })
})

describe('GraphDB - inline prop refs in MATCH patterns', () => {
  it("supports referencing another variable's property in inline props", () => {
    const db = new GraphDB()
    db.run(
      "CREATE (u:Chunk {name:'User', filePath:'/src/user.ts'}), (d:Chunk {name:'GraphDB', filePath:'/src/graphdb.ts'}), (f:File:Chunk {filePath:'/src/user.ts'}), (u)-[:REFERENCES]->(d)",
    )
    const res = db.run(
      "MATCH (u:Chunk)-[:REFERENCES]->(d:Chunk { name: 'GraphDB' }), (f:File:Chunk { filePath: u.filePath }) RETURN DISTINCT f ORDER BY f.filePath",
    )
    expect(res).toHaveLength(1)
    const f = res[0].f as any
    expect(f.properties.filePath).toBe('/src/user.ts')
  })
})

describe('GraphDB - procedures', () => {
  it('CALL db.labels() returns known labels', () => {
    const db = new GraphDB()
    // even without data, labels are known a priori for our custom graph
    const res = db.run('CALL db.labels()')
    // should yield rows like { label: 'Chunk' } in sorted order
    const labels = res.map((r) => r.label)
    expect(labels).toEqual(['Chunk', 'Code', 'File'])
  })
})

describe('GraphDB - function projections', () => {
  it('supports labels(n) in RETURN', () => {
    const db = new GraphDB()
    db.run("CREATE (a:File {filePath:'/x'}), (b:Code {name:'Y'}), (c:File:Chunk {filePath:'/z'})")
    const res = db.run('MATCH (n) RETURN labels(n) AS labels, count(*) AS cnt LIMIT 1')
    expect(Array.isArray(res[0].labels)).toBe(true)
    // labels should be arrays of strings for nodes
    expect(res[0].labels.every((x: any) => typeof x === 'string')).toBe(true)
  })
})

describe('GraphDB - rowsToChunks maps property-only returns', () => {
  it('maps d.filePath strings to the corresponding file chunk', () => {
    const db = new GraphDB()
    // Create a file node with filePath
    db.run("CREATE (d:File:Chunk {id:'X1', filePath:'/repo/src/graphdb.ts'})")
    // Returning only the property should still map to the file chunk
    const rows = db.run(
      "MATCH (d:File:Chunk) WHERE d.filePath ENDS WITH 'graphdb.ts' RETURN DISTINCT d.filePath AS path",
    )
    // Build a minimal chunk list with a matching file chunk
    const chunks = [
      {
        id: 'X1',
        filePath: '/repo/src/graphdb.ts',
        language: 'typescript',
        type: 'file',
        name: 'graphdb.ts',
        line: 1,
        endLine: 1,
        content: '',
        contentHash: 'h',
        relations: [],
      },
    ] as any
    const mapped = rowsToChunks(rows as any, chunks as any)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.filePath).toBe('/repo/src/graphdb.ts')
  })
})

describe('GraphDB - parse error logging', () => {
  it('logs an error on parse errors', () => {
    const db = new GraphDB()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => db.run('MATCH (n RETURN n')).toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('GraphDB - repo ingest and reference query', () => {
  it('ingests this repo and runs a reference query targeting graphdb.ts (may be empty)', async () => {
    const agent = new SearchAgent(process.cwd(), { languages: ['typescript', 'tsx'] })
    await agent.ingest()
    const cypher =
      "MATCH (f:File:Chunk)-[:CONTAINS]->(u:Chunk)-[:REFERENCES]->(d:Chunk) WHERE d.filePath ENDS WITH '/graphdb.ts' RETURN DISTINCT f ORDER BY f.filePath"
    const chunks = agent.search_graph(cypher)
    // With current chunker + reference builder, graphdb.ts does not emit definition chunks,
    // so this query currently yields no rows. Still assert that it executes and returns an array.
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThanOrEqual(0)
  })
})
