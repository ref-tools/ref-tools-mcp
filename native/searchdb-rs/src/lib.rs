use ahash::{AHashMap as HashMap, AHashSet as HashSet};
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn tokenize(s: &str) -> Vec<String> {
  let lower = s.to_lowercase();
  let bytes = lower.as_bytes();
  let mut out: Vec<String> = Vec::new();
  let mut start: isize = -1;
  for (i, &b) in bytes.iter().enumerate() {
    let is_word = (b >= b'a' && b <= b'z') || (b >= b'0' && b <= b'9') || b == b'_';
    if is_word {
      if start < 0 { start = i as isize; }
    } else if start >= 0 {
      out.push(String::from_utf8(bytes[start as usize..i].to_vec()).unwrap());
      start = -1;
    }
  }
  if start >= 0 {
    out.push(String::from_utf8(bytes[start as usize..].to_vec()).unwrap());
  }
  out
}

#[inline]
fn normalize_vec(v: &mut [f32]) {
  let mut sumsq = 0f32;
  for &x in v.iter() { sumsq += x * x; }
  if sumsq > 0.0 {
    let inv = 1.0f32 / sumsq.sqrt();
    for x in v.iter_mut() { *x *= inv; }
  }
}

struct BM25Index {
  postings: HashMap<String, HashMap<String, u32>>, // term -> (docId -> tf)
  doc_len: HashMap<String, u32>,
  doc_terms: HashMap<String, Vec<String>>, // docId -> unique terms
  total_len: u64,
  docs: HashSet<String>,
  k1: f64,
  b: f64,
}

impl BM25Index {
  fn new(k1: f64, b: f64) -> Self {
    Self {
      postings: HashMap::new(),
      doc_len: HashMap::new(),
      doc_terms: HashMap::new(),
      total_len: 0,
      docs: HashSet::new(),
      k1,
      b,
    }
  }

  fn add(&mut self, doc_id: &str, text: &str) {
    let terms = tokenize(text);
    let len = terms.len() as u32;
    if len == 0 { return; }
    let mut tf_map: HashMap<String, u32> = HashMap::new();
    for t in terms.iter() { *tf_map.entry(t.clone()).or_insert(0) += 1; }
    let uniq: Vec<String> = tf_map.keys().cloned().collect();
    for (term, tf) in tf_map.into_iter() {
      let post = self.postings.entry(term).or_insert_with(HashMap::new);
      post.insert(doc_id.to_string(), tf);
    }
    self.doc_len.insert(doc_id.to_string(), len);
    self.total_len += len as u64;
    self.doc_terms.insert(doc_id.to_string(), uniq);
    self.docs.insert(doc_id.to_string());
  }

  fn remove(&mut self, doc_id: &str) {
    if !self.docs.contains(doc_id) { return; }
    if let Some(terms) = self.doc_terms.get(doc_id) {
      for term in terms.iter() {
        if let Some(post) = self.postings.get_mut(term) {
          post.remove(doc_id);
          if post.is_empty() { self.postings.remove(term); }
        }
      }
    } else {
      for (_term, post) in self.postings.iter_mut() { post.remove(doc_id); }
    }
    if let Some(len) = self.doc_len.remove(doc_id) {
      self.total_len = self.total_len.saturating_sub(len as u64);
    }
    self.doc_terms.remove(doc_id);
    self.docs.remove(doc_id);
  }

  fn top_k(&self, query: &str, top_k: usize) -> Vec<(String, f64)> {
    if top_k == 0 || self.docs.is_empty() { return Vec::new(); }
    let mut seen: HashSet<String> = HashSet::new();
    let mut q_terms: Vec<String> = Vec::new();
    for t in tokenize(query).into_iter() {
      if seen.insert(t.clone()) { q_terms.push(t); }
    }
    if q_terms.is_empty() { return Vec::new(); }
    let n_docs = std::cmp::max(1, self.docs.len()) as f64;
    let avgdl = if self.total_len > 0 { self.total_len as f64 / n_docs } else { 0.0001 };
    let mut scores: HashMap<String, f64> = HashMap::new();
    let mut denom_cache: HashMap<String, f64> = HashMap::new();
    for term in q_terms.iter() {
      let post = match self.postings.get(term) { Some(p) => p, None => continue };
      let df = post.len() as f64;
      let idf = (1.0 + (n_docs - df + 0.5) / (df + 0.5)).ln();
      let mult = idf * (self.k1 + 1.0);
      for (doc_id, tf) in post.iter() {
        let base = *denom_cache.entry(doc_id.clone()).or_insert_with(|| {
          let dl = *self.doc_len.get(doc_id).unwrap_or(&0) as f64;
          self.k1 * (1.0 - self.b + self.b * dl / avgdl)
        });
        let denom = (*tf as f64) + base;
        let s = mult * ((*tf as f64) / if denom == 0.0 { 1e-9 } else { denom });
        *scores.entry(doc_id.clone()).or_insert(0.0) += s;
      }
    }
    // select top_k
    let mut pairs: Vec<(String, f64)> = scores.into_iter().collect();
    pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    if pairs.len() > top_k { pairs.truncate(top_k); }
    pairs
  }
}

struct VectorIndex {
  dim: usize,
  data: Vec<f32>,
  ids: Vec<String>,
  id_to_row: HashMap<String, usize>,
}

impl VectorIndex {
  fn new() -> Self {
    Self { dim: 0, data: Vec::new(), ids: Vec::new(), id_to_row: HashMap::new() }
  }

  #[inline]
  fn ensure_capacity(&mut self, rows: usize, dim: usize) {
    if self.dim == 0 { self.dim = dim; }
    let need = rows * self.dim;
    if need <= self.data.len() { return; }
    let mut cap = if self.data.len() == 0 { 1024 } else { self.data.len() };
    while cap < need { cap *= 2; }
    self.data.resize(cap, 0.0);
  }

  fn add(&mut self, id: &str, vec: &[f32]) {
    let d = if self.dim == 0 { vec.len() } else { self.dim };
    self.ensure_capacity(self.ids.len() + 1, d);
    let row = self.ids.len();
    self.ids.push(id.to_string());
    self.id_to_row.insert(id.to_string(), row);
    let off = row * self.dim;
    let mut tmp = vec.to_vec();
    if tmp.len() < self.dim { tmp.resize(self.dim, 0.0); }
    normalize_vec(&mut tmp);
    for i in 0..self.dim { self.data[off + i] = tmp[i]; }
  }

  fn update(&mut self, id: &str, vec: &[f32]) {
    if let Some(&row) = self.id_to_row.get(id) {
      let off = row * self.dim;
      let mut tmp = vec.to_vec();
      if tmp.len() < self.dim { tmp.resize(self.dim, 0.0); }
      normalize_vec(&mut tmp);
      for i in 0..self.dim { self.data[off + i] = tmp[i]; }
    } else {
      self.add(id, vec);
    }
  }

  fn remove(&mut self, id: &str) {
    let Some(&row) = self.id_to_row.get(id) else { return; };
    let last = self.ids.len() - 1;
    if row != last {
      self.ids[row] = self.ids[last].clone();
      self.id_to_row.insert(self.ids[row].clone(), row);
      let src = last * self.dim;
      let dst = row * self.dim;
      for i in 0..self.dim { self.data[dst + i] = self.data[src + i]; }
    }
    self.ids.pop();
    self.id_to_row.remove(id);
  }

  fn top_k(&self, query_vec: &[f32], k: usize) -> Vec<(String, f32)> {
    if k == 0 || self.ids.is_empty() { return Vec::new(); }
    let d = self.dim;
    let mut q = query_vec.to_vec();
    if q.len() < d { q.resize(d, 0.0); }
    normalize_vec(&mut q);

    let mut heap: Vec<(usize, f32)> = Vec::new();
    let rows = self.ids.len();
    for row in 0..rows {
      let off = row * d;
      let mut dot = 0f32;
      let limit = d - (d % 4);
      let mut i = 0;
      while i < limit {
        dot += self.data[off + i] * q[i];
        dot += self.data[off + i + 1] * q[i + 1];
        dot += self.data[off + i + 2] * q[i + 2];
        dot += self.data[off + i + 3] * q[i + 3];
        i += 4;
      }
      while i < d { dot += self.data[off + i] * q[i]; i += 1; }
      if heap.len() < k {
        heap.push((row, dot));
        heap.sort_by(|a,b| a.1.partial_cmp(&b.1).unwrap());
      } else if dot > heap[0].1 {
        heap[0] = (row, dot);
        heap.sort_by(|a,b| a.1.partial_cmp(&b.1).unwrap());
      }
    }
    let mut out: Vec<(String, f32)> = heap.into_iter().map(|(ri, s)| (self.ids[ri].clone(), s)).collect();
    out.sort_by(|a,b| b.1.partial_cmp(&a.1).unwrap());
    out
  }
}

struct SearchIndexCore {
  bm25: BM25Index,
  vectors: VectorIndex,
}

impl SearchIndexCore {
  fn new() -> Self { Self { bm25: BM25Index::new(1.5, 0.75), vectors: VectorIndex::new() } }
}

#[napi(object)]
pub struct PairIdScore {
  pub id: String,
  pub s: f64,
}

#[napi]
pub struct SearchIndex {
  core: std::sync::Mutex<SearchIndexCore>,
}

#[napi]
impl SearchIndex {
  #[napi(constructor)]
  pub fn new() -> Self { Self { core: std::sync::Mutex::new(SearchIndexCore::new()) } }

  #[napi]
  pub fn add_doc(&self, id: String, bm25_text: String, embedding: Float32Array) -> Result<()> {
    let mut g = self.core.lock().unwrap();
    g.bm25.add(&id, &bm25_text);
    g.vectors.add(&id, embedding.as_ref());
    Ok(())
  }

  #[napi]
  pub fn update_doc(&self, id: String, bm25_text: String, embedding: Float32Array) -> Result<()> {
    let mut g = self.core.lock().unwrap();
    // remove then add to keep bm25 in sync
    g.bm25.remove(&id);
    g.bm25.add(&id, &bm25_text);
    g.vectors.update(&id, embedding.as_ref());
    Ok(())
  }

  #[napi]
  pub fn remove_doc(&self, id: String) {
    let mut g = self.core.lock().unwrap();
    g.bm25.remove(&id);
    g.vectors.remove(&id);
  }

  #[napi]
  pub fn bm25_top_k(&self, query: String, k: u32) -> Vec<PairIdScore> {
    let g = self.core.lock().unwrap();
    g.bm25
      .top_k(&query, k as usize)
      .into_iter()
      .map(|(id, s)| PairIdScore { id, s })
      .collect()
  }

  #[napi]
  pub fn knn_top_k(&self, query_vec: Float32Array, k: u32) -> Result<Vec<PairIdScore>> {
    let g = self.core.lock().unwrap();
    Ok(g
      .vectors
      .top_k(query_vec.as_ref(), k as usize)
      .into_iter()
      .map(|(id, s)| PairIdScore { id, s: s as f64 })
      .collect())
  }

  #[napi]
  pub fn union_candidates(&self, query: String, query_vec: Float32Array, bm25_k: u32, knn_k: u32) -> Result<Vec<String>> {
    let g = self.core.lock().unwrap();
    let bm = g.bm25.top_k(&query, bm25_k as usize);
    let knn = g.vectors.top_k(query_vec.as_ref(), knn_k as usize);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for (id, _) in bm.into_iter() {
      if seen.insert(id.clone()) { out.push(id); }
    }
    for (id, _) in knn.into_iter() {
      if seen.insert(id.clone()) { out.push(id); }
    }
    Ok(out)
  }
}

// removed generic TypedArray helper in favor of concrete Float32Array with zero-copy slice access

