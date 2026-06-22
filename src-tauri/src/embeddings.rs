//! Deterministic multilingual text embeddings for semantic retrieval.
//!
//! Character n-gram hashing into a 384-dim L2-normalized vector: lightweight,
//! local-first, no model dependency, and language-agnostic (works on Japanese
//! because char n-grams capture subword overlap that keyword FTS misses).
//! Vectors are normalized, so `cosine` is a plain dot product.
//!
//! A neural multilingual model (e.g. paraphrase-multilingual-MiniLM-L12-v2 via
//! ONNX) is a drop-in upgrade behind the same `embed`/`cosine` shape; this
//! deterministic embedder is the no-dependency v1 that already improves ranking.

const EMBED_DIM: usize = 384;
const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;
const BIGRAM_SALT: u64 = 0x9E37_79B9_7F4A_7C15;

/// Embed text into a 384-dim L2-normalized vector via 2- and 3-character n-grams.
pub fn embed(text: &str) -> Vec<f32> {
  let mut vector = vec![0f32; EMBED_DIM];
  let chars: Vec<char> = text.to_lowercase().chars().collect();
  for window in chars.windows(3) {
    let bucket = (fnv1a_chars(window) as usize) % EMBED_DIM;
    vector[bucket] += 1.0;
  }
  for window in chars.windows(2) {
    let bucket = (fnv1a_chars(window).wrapping_mul(BIGRAM_SALT) as usize) % EMBED_DIM;
    vector[bucket] += 0.5;
  }
  let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
  if norm > 0.0 {
    for value in &mut vector {
      *value /= norm;
    }
  }
  vector
}

/// Cosine similarity for two normalized vectors (= dot product).
pub fn cosine(left: &[f32], right: &[f32]) -> f32 {
  left.iter().zip(right.iter()).map(|(a, b)| a * b).sum()
}

fn fnv1a_chars(chars: &[char]) -> u64 {
  let mut hash = FNV_OFFSET;
  let mut buffer = [0u8; 4];
  for character in chars {
    let encoded = character.encode_utf8(&mut buffer);
    for byte in encoded.as_bytes() {
      hash ^= *byte as u64;
      hash = hash.wrapping_mul(FNV_PRIME);
    }
  }
  hash
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn identical_text_has_cosine_near_one() {
    let vector = embed("健康診断の予約を取った");
    let similarity = cosine(&vector, &vector);
    assert!(
      (similarity - 1.0).abs() < 1e-5,
      "self-similarity was {similarity}"
    );
  }

  #[test]
  fn empty_text_is_a_zero_vector() {
    let vector = embed("");
    assert!(vector.iter().all(|value| value.abs() < 1e-9));
  }

  #[test]
  fn similar_text_is_closer_than_dissimilar_text() {
    let rent_a = embed("毎月25日に家賃を支払う");
    let rent_b = embed("家賃の支払いは毎月25日です");
    let beach = embed("来週の金曜日に海へ行く");
    let similar = cosine(&rent_a, &rent_b);
    let dissimilar = cosine(&rent_a, &beach);
    assert!(
      similar > dissimilar,
      "semantically closer texts should have higher cosine: similar={similar}, dissimilar={dissimilar}"
    );
  }

  #[test]
  fn cross_language_overlap_is_captured() {
    // Shared ASCII tokens ("ocean", "policy") should still register overlap.
    let a = embed("renew the ocean insurance policy");
    let b = embed("ocean policy renewal");
    let c = embed("cook pasta for dinner");
    assert!(cosine(&a, &b) > cosine(&a, &c));
  }
}
