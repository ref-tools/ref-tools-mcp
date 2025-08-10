# mcpui endpoint + client
[x] try goose 
[x] add endpoint that shows mcp ui
  [x] try in goose
[x] try having gpt5 generate some ui
[x] gpt5 generate a d3js solar system
[x] try gpt5 generating
[x] build and run goose from source https://github.com/block/goose/blob/main/CONTRIBUTING.md
[x] get a higher ui
- local build with grow heigh button works

# knowledge graph
[x] gpt5 build a in-memory graph db that supports cypher https://github.com/ref-tools/ref-tools-mcp/pull/12
  [x] fix type errors from npm run check
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
[x] build this https://github.com/ref-tools/ref-tools-mcp/pull/14



# connected cli
[x] SearchAgent(directory)
  - ingests a directory to chunks, embeds, creates graph deb
  - has search(query) fn that runs an agent that has search_graph(cypher) and search_query(prompt) tools
[x] cli that wraps Searcher and allows running queries at terminal. it should show some nice loading animation and then 
[x] searcher has a watcher
[x] merkle tree for updating as files update
https://github.com/ref-tools/ref-tools-mcp/pull/15
[x] dig in and manually debug to make sure it works good
[x] add in pick docs
[] fix up knowledge graph to be sure it works good
[] chunk the right amounts
[] mode that just returns name and allow loading thecontents as needed

# persistence for different dbs
[] should allow restarting search agent and compare merkel tree to data

# connected mcp server
[] require a directory and openai env variables in config, otherwise don't setup these capabilites
[] launch a SearchAgent in the directory
[] tool search_deep_dive() to find info about the repo that calls search agent 
[] tools search_code_text() and search_code_graph() for direct searches 

# visual results
x] Update SearchAgent to optionally be able to return a visual with mcp-ui 


# see how much it can improve itself
[x] generate a bench mark test for each searchdb, graphdb (save results to a file, have a ui for viewing) https://github.com/ref-tools/ref-tools-mcp/pull/16
[] add more larger repos
[] improve the UI and make it more digest able across
[] optimize the shit out of in-memory systems
- do this 3 times
[] rewrite in rust with bindings (do on repeat)


