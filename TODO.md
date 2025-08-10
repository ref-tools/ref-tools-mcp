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
[x] fix up knowledge graph to be sure it works good
[x] improve pick
[x] update graphdb to return Chunks 
[] add read tool and have search agent return 

# persistence for different dbs
[] should allow restarting search agent, reloading serialized data and compare merkel tree to data

# connected mcp server
[x] require a REF_DIRECTORY and OPENAI_API_KEY env variables in config, otherwise don't setup these capabilites
[x] launch a SearchAgent in the directory
[x] tools search_code_text() (reuse searchQuery) and search_code_graph() (reuse searchGraph) for direct searches, have these just return 

# visual results
[x] Update SearchAgent to optionally be able to return a visual with mcp-ui 
[x] visualize tool that will take a prompt + automaitcally dump the entire graph into context https://github.com/ref-tools/ref-tools-mcp/pull/26

# see how much it can improve itself
[x] generate a bench mark test for each searchdb, graphdb (save results to a file, have a ui for viewing) https://github.com/ref-tools/ref-tools-mcp/pull/16
[x] add more larger repos
[x] graph should show average of all qieries.  
[x] improve the UI and make it more digest able across
[] optimize the shit out of searchdb
- do this 3 times
[] rewrite in rust with bindings (do on repeat)

# demo script
- i build ref tools, find context for coding agents, specializing in finding exactly the right tokens and nothing more
- for this hackathons the goal is see what gpt5 can do so i decided to work on adding code-indexing to ref's mcp server
- (show mcp tools) ref already has search_docs and readurl, we now add 
- (demo in goose - look up searchdb and how it is used)
- okay that's cool we built an mcp server to chunk and build a graph index. 
- normally id use a server, turbopuffer,neo4j etc but the goal is test gpt5 so i had gpt5 implement the graph/text/vector dbs from scratch
- now we have that, i wanted to see how good they were so i had gpt5 write a benchmark 
- (demo benchmark) and now we have a bench mark
- ...and ofcourse now we're optimizing, we have to rewrite everythign to rust. so gpt5 did that

- gpt5 is supposed to be good at generating ui, there's one more tool i hid from you  (vizualize_codebase)
- (demo vizuali) uses mcp-ui to show an html ui. this is entirely
- everything here written with gpt5 between cursor and codex hosted by terragonlabs