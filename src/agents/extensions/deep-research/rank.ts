import type { ExaResult, RankedSnippet } from "./types.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "what", "which",
  "who", "whom", "this", "that", "these", "those", "am", "it", "its",
]);

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function heuristicRank(snippets: ExaResult[], query: string): RankedSnippet[] {
  const queryTerms = extractKeywords(query);

  if (queryTerms.length === 0) {
    return snippets
      .map(s => ({
        ...s,
        exa_score: s.score,
        heuristic_score: 0,
        combined_score: s.score,
      }))
      .sort((a, b) => b.combined_score - a.combined_score);
  }

  const queryLower = query.toLowerCase();

  return snippets
    .map(s => {
      const textLower = (s.text || "").toLowerCase();
      const titleLower = (s.title || "").toLowerCase();

      const termMatches = queryTerms.filter(t => textLower.includes(t)).length;
      const termScore = termMatches / queryTerms.length;
      const titleBonus = queryTerms.some(t => titleLower.includes(t)) ? 0.2 : 0;
      const highlightBonus = s.highlights?.length
        ? Math.min(s.highlights.length * 0.1, 0.3)
        : 0;
      // Penalize very short snippets — usually navigational or boilerplate
      const lengthPenalty = (s.text?.length || 0) < 200 ? -0.2 : 0;
      const phraseBonus = textLower.includes(queryLower) ? 0.3 : 0;

      const heuristic_score = Math.min(
        1,
        Math.max(0, termScore + titleBonus + highlightBonus + lengthPenalty + phraseBonus),
      );

      // 60/40 blend: Exa's semantic relevance weighted higher than keyword heuristics
      const combined_score = s.score * 0.6 + heuristic_score * 0.4;

      return { ...s, exa_score: s.score, heuristic_score, combined_score };
    })
    .sort((a, b) => b.combined_score - a.combined_score);
}
