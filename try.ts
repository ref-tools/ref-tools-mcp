import { GraphDB } from './graphdb.ts'
const db = new GraphDB()
try {
  const res = db.run("CREATE (a:Person {name:'A'})-[:KNOWS {since:2020}]->(b:Person {name:'B'})")
  console.log('RESULT', res)
} catch (e:any) {
  console.log('ERROR', e.message)
}
