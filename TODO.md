# mcpui endpoint + client
[x] try goose 
[x] add endpoint that shows mcp ui
  [x] try in goose
[x] try having gpt5 generate some ui
[] gpt5 generate a d3js solar system
[] try gpt5 generating

# knowledge graph
[x] gpt5 build a in-memory graph db that supports cypher https://github.com/ref-tools/ref-tools-mcp/pull/12
[x] ast parsing to chunks https://github.com/ref-tools/ref-tools-mcp/pull/13
  [x] reogranize chunking code and cli 
  [x] fix tree-sitter install
  [] test ast parsing manually
[] generate a knowledge graph from directory

# in-memory vectordb
- store(chunk) [all CRUD operations] - uses gpt5-nano to breifly label chunk, openai api to embed
- search(query) -> node[] - knn returns hashes + use gpt5-nano to select which are relevant, this will return hashes
- storage of hash->array<node> - node should be able to use this to lookup in graphdb

# ref indexing endpoint
[] ref endpoint for indexing chunks to private index
[] gpt5-nano labelling chunks 

# up-to-date indexin
[] merkle tree for updating only as needed
