import { describe, it, expect } from 'vitest'
import { GraphDB } from './graphdb'
import type { Node, Relationship } from './graphdb'

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
    const res = db.run("MATCH (p:Person {age:20}) RETURN p")
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
    db.run("CREATE (a:Person {name:'A'})-[:KNOWS {since:2020}]->(b:Person {name:'B'}), (a)-[:KNOWS {since:2010}]->(c:Person {name:'C'})")
    const res = db.run('MATCH (a:Person)-[r:KNOWS]->(b:Person) WHERE r.since >= 2015 RETURN count(*) AS cnt')
    expect(res).toEqual([{ cnt: 1 }])
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
    db.run("CREATE (a:Person {name:'A', age:20}), (b:Person {name:'B', age:30}), (c:Person {name:'C', age:40})")
    const res = db.run('MATCH (p:Person) WHERE (p.age >= 30 AND p.age < 40) OR p.name = "A" RETURN collect(p) AS arr')
    // Should include A (age 20 by name) and B (30), exclude C (40)
    expect(Array.isArray(res[0].arr)).toBe(true)
    const names = (res[0].arr as Node[]).map((n) => n.properties.name).sort()
    expect(names).toEqual(['A', 'B'])
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
    db.run("CREATE (a:Person), (b:Person), (c:Animal)")
    const c1 = db.run('MATCH (n) RETURN count(*) AS total')
    expect(c1).toEqual([{ total: 3 }])
    const c2 = db.run('MATCH (p:Person) RETURN count(p) AS persons')
    expect(c2).toEqual([{ persons: 2 }])
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
