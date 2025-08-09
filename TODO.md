# mcpui endpoint + client
[x] try goose 
[x] add endpoint that shows mcp ui
  [x] try in goose
[x] try having gpt5 generate some ui
[] get a higher ui
[] gpt5 generate a d3js solar system
[] try gpt5 generating

# knowledge graph
[x] gpt5 build a in-memory graph db that supports cypher https://github.com/ref-tools/ref-tools-mcp/pull/12
  [] fix type errors from npm run check
[x] ast parsing to chunks https://github.com/ref-tools/ref-tools-mcp/pull/13
  [x] reogranize chunking code and cli 
  [x] fix tree-sitter install
  [x] test ast parsing manually

# in-memory searchdb
- store(chunk) [all CRUD operations] - uses gpt5-nano to breifly label chunk, openai api to embed
  - local cache ~/.ref to store hash->{embedding, description}
- search(query) -> node[] 
  hybrid search (return N of each)
  - knn returns hashes + use gpt5-nano to select which are relevant, this will return hashes
  - in memory bm25 search as well
- storage of hash->array<node> - node should be able to use this to lookup in graphdb

# connected 
[] cli to generate an run a search
  - passes off to inner agent that has search_graph(cypher) and search_query(prompt)
[] search_code() tool that
[] merkle tree for updating as files update
[] 

# benchmarks for the performance of various in-mem systems
- create a bench mark
- find tools to compare and see performance (eg scale and speed)

# ref indexing endpoint
[] ref endpoint for indexing chunks to private index
[] gpt5-nano labelling chunks 

