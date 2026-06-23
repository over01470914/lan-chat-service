export function categorizeFile(name, mimeType = '') {
  const lower = String(name || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || /\.(txt|md|markdown|json|csv|log|yaml|yml|xml|html|css|js|ts)$/i.test(lower)) return 'text';
  if (/\.(pdf|doc|docx|ppt|pptx|xls|xlsx|pages|numbers|key|rtf|odt|ods|odp)$/i.test(lower)) return 'document';
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|dmg|apk|ipa|pkg)$/i.test(lower)) return 'archive';
  return 'other';
}

export function shortType(name, category = 'file') {
  const extension = String(name || '').split('.').pop();
  if (extension && extension !== name && extension.length <= 4) return extension.toLowerCase();
  return String(category || 'file').slice(0, 3).toLowerCase();
}

export function getFilePreviewKind(name, mimeType = '') {
  const category = categorizeFile(name, mimeType);
  return category === 'image' || category === 'video' ? category : 'icon';
}

export function fuzzyMatch(value, query) {
  return fuzzyScore(value, query) > 0;
}

export function fuzzyScore(value, query) {
  const target = normalize(value);
  const needle = normalize(query);
  if (!needle) return 1;
  if (!target) return 0;
  if (target.includes(needle)) return 100;
  if (isSubsequence(needle, target)) return 78;

  const queryTerms = splitTerms(query).map(normalize).filter(Boolean);
  const targetTerms = splitTerms(value).map(normalize).filter(Boolean);
  if (queryTerms.length) {
    const termScores = queryTerms.map((term) => bestTermScore(term, targetTerms, target));
    if (termScores.every((score) => score > 0)) return Math.min(...termScores);
  }

  if (isCloseTypo(needle, target)) return 66;
  if (bigramDice(target, needle) >= 0.55) return 58;
  return 0;
}

function bestTermScore(term, targetTerms, fullTarget) {
  if (fullTarget.includes(term)) return 94;
  let best = 0;
  for (const candidate of targetTerms) {
    if (candidate.includes(term)) best = Math.max(best, 90);
    else if (isSubsequence(term, candidate)) best = Math.max(best, 74);
    else if (isCloseTypo(term, candidate)) best = Math.max(best, 68);
    else if (bigramDice(candidate, term) >= 0.58) best = Math.max(best, 58);
  }
  return best;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function splitTerms(value) {
  return String(value || '').split(/[^\p{L}\p{N}]+/u);
}

function isSubsequence(needle, target) {
  if (!needle) return true;
  let index = 0;
  for (const char of target) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function isCloseTypo(needle, target) {
  if (!needle || !target) return false;
  const maxDistance = needle.length <= 4 ? 1 : Math.max(1, Math.floor(needle.length * 0.28));
  if (Math.abs(needle.length - target.length) > maxDistance) return false;
  return levenshteinDistance(needle, target, maxDistance) <= maxDistance;
}

function levenshteinDistance(a, b, maxDistance = Infinity) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) return rowMin;
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function bigramDice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = counts.get(pair) || 0;
    if (count > 0) {
      counts.set(pair, count - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (a.length + b.length - 2);
}
