export const ENRICHMENT_VERSION = "toeic-enrichment-v3";
export const SKILL_TAG_VERSION = "toeic-skills-v3";
export const IMAGE_ALT_VERSION = "toeic-alt-v3";
export const QUESTION_SKILL_TAGS = [
  "action",
  "adjective",
  "adverb",
  "choice",
  "cohesion",
  "collocation",
  "conditional",
  "conjunction",
  "detail",
  "determiner",
  "duration",
  "frequency",
  "gerund",
  "gist",
  "grammar",
  "graphic_interpretation",
  "indirect_response",
  "inference",
  "infinitive",
  "information",
  "listening_comprehension",
  "location",
  "manner",
  "negative_detail",
  "next_action",
  "noun",
  "object_identification",
  "paraphrase",
  "participle",
  "passive_voice",
  "person",
  "photo_description",
  "preposition",
  "present_continuous",
  "pronoun",
  "purpose",
  "quantity",
  "question_response",
  "reading_comprehension",
  "reason",
  "relative_clause",
  "request_offer",
  "sentence_completion",
  "sentence_insertion",
  "speaker_identity",
  "spatial_relation",
  "state_description",
  "statement_response",
  "subject_verb_agreement",
  "text_completion",
  "time",
  "unclassified",
  "verb_tense",
  "vocabulary",
  "vocabulary_in_context",
  "word_form",
  "yes_no",
] as const;

export type QuestionSkillTag = (typeof QUESTION_SKILL_TAGS)[number];

type SourceQuestionLike = Record<string, unknown> & {
  part?: number | undefined;
  question_number?: number | undefined;
  question_text?: string | null | undefined;
  option_a?: string | null | undefined;
  option_b?: string | null | undefined;
  option_c?: string | null | undefined;
  option_d?: string | null | undefined;
  correct_answer?: string | null | undefined;
  explanation_vi?: string | null | undefined;
  explanation_en?: string | null | undefined;
  dich_nghia?: string | null | undefined;
  dich_nghia_dap_an?: string | null | undefined;
  image_url?: string | null | undefined;
};

export interface QuestionEnrichment {
  generatedExplanationVi: string | null;
  explanationSource: "source" | "derived";
  imageAltText: string | null;
  imageAltSource: string | null;
  imageAltNeedsReview: boolean;
  imageAltVersion: string | null;
  skillTags: string[];
  skillTagVersion: string;
  enrichmentVersion: string;
}

export interface QuestionEnrichmentContext {
  groupImageAltText?: string | null | undefined;
  groupImageAltSource?: string | null | undefined;
  groupImageAltNeedsReview?: boolean | undefined;
  groupContentText?: string | null | undefined;
  groupTranscript?: string | null | undefined;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function nested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function optionFor(
  source: SourceQuestionLike,
  key = source.correct_answer,
): string | null {
  if (!key || !/^[A-D]$/.test(key)) {
    return null;
  }
  return clean(source[`option_${key.toLowerCase()}`]);
}

export function isOptionListTranslation(source: SourceQuestionLike): boolean {
  if (clean(source.explanation_vi)) {
    return false;
  }
  const value = source.explanation_en?.trim();
  if (!value) {
    return false;
  }
  const optionLabels = new Set(
    [...value.matchAll(/(?:^|\n)\s*([A-D])[.)]\s+/g)].map((match) => match[1]),
  );
  return (
    optionLabels.size >= 3 &&
    !/\b(?:correct|because|evidence)\b|dẫn chứng|đáp án\s+[A-D]\s+đúng/i.test(
      value,
    )
  );
}

function translatedOption(source: SourceQuestionLike): string | null {
  const key = source.correct_answer;
  const optionListTranslation = isOptionListTranslation(source)
    ? source.explanation_en
    : null;
  const translations = [
    source.dich_nghia_dap_an,
    source.dich_nghia,
    optionListTranslation,
  ].filter((value): value is string => Boolean(value));
  if (!key || !translations.length) {
    return null;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const translation of translations) {
    const match = translation.match(
      new RegExp(`\\(${escaped}\\)\\s*([\\s\\S]*?)(?=\\s*\\([A-D]\\)|$)`, "i"),
    );
    if (match?.[1]) {
      return clean(match[1]);
    }
    const lineMatch = translation.match(
      new RegExp(
        `(?:^|\\n)\\s*${escaped}[.)]\\s*([\\s\\S]*?)(?=\\n\\s*[A-D][.)]\\s|$)`,
        "i",
      ),
    );
    if (lineMatch?.[1]) {
      return clean(lineMatch[1]);
    }
  }
  return null;
}

function sourceExplanationKind(
  source: SourceQuestionLike,
): QuestionEnrichment["explanationSource"] {
  if (
    clean(source.explanation_vi) ||
    (clean(source.explanation_en) && !isOptionListTranslation(source))
  ) {
    return "source";
  }
  return "derived";
}

function questionStem(source: SourceQuestionLike): string {
  const explicitQuestion = clean(source.question_text);
  if (explicitQuestion) {
    return explicitQuestion
      .replace(/^[MW]-[A-Za-z]+:\s*/i, "")
      .replace(/\s+[MW]-[A-Za-z]+:\s*$/i, "")
      .trim();
  }
  const translation = clean(source.dich_nghia);
  return translation?.split(/\s*\(A\)\s*/i)[0]?.trim() ?? "";
}

function part2Intent(source: SourceQuestionLike): {
  tag: QuestionSkillTag;
  description: string;
} {
  const text = questionStem(source).toLowerCase();
  const rules: Array<[RegExp, QuestionSkillTag, string]> = [
    [/\bwhere\b|ở đâu|nơi nào/, "location", "địa điểm"],
    [/\bwhen\b|what time|mấy giờ|khi nào/, "time", "thời gian"],
    [/how long|bao lâu/, "duration", "khoảng thời gian"],
    [/how often|bao lâu một lần|thường xuyên/, "frequency", "tần suất"],
    [/\bwhy\b|tại sao|vì sao/, "reason", "lý do"],
    [/\bwho\b|\bwhose\b|\bwhom\b|\bai\b|của ai/, "person", "người"],
    [/how many|how much|bao nhiêu/, "quantity", "số lượng"],
    [/\bwhich\b|\bor\b|cái nào|nào tốt hơn| hay /, "choice", "lựa chọn"],
    [
      /\bhow\b|bằng cách nào|như thế nào|thế nào/,
      "manner",
      "cách thức hoặc đánh giá được hỏi",
    ],
    [/\bwhat\b|cái gì|điều gì/, "information", "thông tin được hỏi"],
  ];
  for (const [pattern, tag, description] of rules) {
    if (pattern.test(text)) {
      return { tag, description };
    }
  }
  if (
    /^(?:would|could|can|will|shall|should|may|please|let's|let us)(?=\s|$)|vui lòng|hãy |chúng ta hãy/.test(
      text.trim(),
    )
  ) {
    return { tag: "request_offer", description: "lời đề nghị hoặc yêu cầu" };
  }
  if (
    /^(is|are|am|was|were|do|does|did|has|have|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|hasn't|haven't|hadn't|can't|couldn't|won't|wouldn't|shouldn't)\b|chẳng phải|đúng không|phải không|(?:^|\s)chưa(?:\s|[?!.]|$)|có.*không/.test(
      text.trim(),
    )
  ) {
    return { tag: "yes_no", description: "thông tin cần xác nhận" };
  }
  return { tag: "statement_response", description: "ngữ cảnh của lời nói" };
}

function completedPrompt(
  source: SourceQuestionLike,
  option: string,
): string | null {
  const prompt = clean(source.question_text);
  if (!prompt || !/[-–—_]{3,}|\.{3,}/.test(prompt)) {
    return null;
  }
  return prompt.replace(/[-–—_]{3,}|\.{3,}/, option);
}

const EVIDENCE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "most",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function plainText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/([.!?])\s*\./g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceTokens(value: string): Set<string> {
  const tokens = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/\$?\d+(?:[.,]\d+)?|[a-z]+/g);
  return new Set(
    (tokens ?? [])
      .map((token) => token.replace(/,/g, ""))
      .map((token) =>
        token.length > 5
          ? token.replace(/(?:ing|ied|ed|es|s)$/i, (ending) =>
              ending === "ied" ? "y" : "",
            )
          : token,
      )
      .filter((token) => token.length > 1 && !EVIDENCE_STOP_WORDS.has(token)),
  );
}

function supportingExcerpt(
  source: SourceQuestionLike,
  context: QuestionEnrichmentContext,
): string | null {
  const answer = optionFor(source);
  if (!answer) {
    return null;
  }
  const answerTokens = evidenceTokens(answer);
  const question = questionStem(source);
  const questionTokens = evidenceTokens(question);
  const vocabularyTarget = question.match(
    /(?:word|phrase)\s+["“']([^"”']+)["”']/i,
  )?.[1];
  const vocabularyTokens = evidenceTokens(vocabularyTarget ?? "");
  if (!answerTokens.size) {
    return null;
  }
  const candidates = [
    context.groupTranscript,
    context.groupContentText,
    context.groupImageAltText,
  ]
    .map(clean)
    .filter((value): value is string => Boolean(value))
    .flatMap((value) =>
      plainText(value)
        .split(/(?<=[.!?])\s+|\s*[|•]\s*/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length >= 12),
    );
  let best: { text: string; score: number } | null = null;
  for (const candidate of candidates) {
    const tokens = evidenceTokens(candidate);
    const answerOverlap = [...answerTokens].filter((token) =>
      tokens.has(token),
    ).length;
    const vocabularyOverlap = [...vocabularyTokens].filter((token) =>
      tokens.has(token),
    ).length;
    if (!answerOverlap && !vocabularyOverlap) {
      continue;
    }
    const questionOverlap = [...questionTokens].filter((token) =>
      tokens.has(token),
    ).length;
    const score =
      answerOverlap * 10 + vocabularyOverlap * 10 + questionOverlap * 2;
    if (!best || score > best.score) {
      best = { text: candidate, score };
    }
  }
  return best
    ? best.text.replace(/^["“”']+\s*|\s*["“”']+$/g, "").slice(0, 450)
    : null;
}

function skillReason(tags: ReadonlySet<QuestionSkillTag>): string {
  const reasons: Array<[QuestionSkillTag, string]> = [
    ["verb_tense", "thì và dạng động từ theo mốc thời gian của câu"],
    ["passive_voice", "cấu trúc bị động"],
    ["subject_verb_agreement", "sự hòa hợp giữa chủ ngữ và động từ"],
    ["word_form", "từ loại cần thiết tại vị trí trống"],
    ["noun", "vai trò danh từ tại vị trí trống"],
    ["adjective", "vai trò tính từ bổ nghĩa cho danh từ"],
    ["adverb", "vai trò trạng từ bổ nghĩa cho động từ hoặc tính từ"],
    ["preposition", "cách dùng giới từ trong cụm từ"],
    ["conjunction", "quan hệ logic giữa các mệnh đề"],
    ["pronoun", "dạng đại từ phù hợp với chức năng trong câu"],
    ["determiner", "từ hạn định phù hợp với danh từ"],
    ["relative_clause", "cấu trúc mệnh đề quan hệ"],
    ["conditional", "cấu trúc câu điều kiện"],
    ["collocation", "cụm từ thường đi cùng nhau"],
    ["vocabulary", "nghĩa của từ trong ngữ cảnh"],
  ];
  return reasons.find(([tag]) => tags.has(tag))?.[1] ?? "ngữ pháp và ngữ cảnh";
}

function deriveExplanation(
  source: SourceQuestionLike,
  skillTags: readonly string[],
  context: QuestionEnrichmentContext,
): string | null {
  const answer = source.correct_answer;
  const correctOption = optionFor(source);
  if (!answer || !correctOption) {
    return null;
  }
  const translated = translatedOption(source);
  const translatedSuffix = translated ? ` (${translated})` : "";
  if (source.part === 1) {
    return `Đáp án ${answer} đúng vì “${correctOption}”${translatedSuffix} mô tả phù hợp với nội dung chính của ảnh. Các lựa chọn còn lại mô tả sai hành động, đối tượng, trạng thái hoặc vị trí trong ảnh.`;
  }
  if (source.part === 2) {
    const intent = part2Intent(source);
    return `Đáp án ${answer} đúng vì câu trả lời “${correctOption}”${translatedSuffix} phù hợp với ${intent.description}. Các lựa chọn còn lại trả lời sai loại thông tin hoặc không phù hợp với ngữ cảnh.`;
  }
  if (source.part === 3 || source.part === 4 || source.part === 7) {
    const passageKind =
      source.part === 3
        ? "đoạn hội thoại"
        : source.part === 4
          ? "bài nói"
          : "bài đọc";
    const evidence = supportingExcerpt(source, context);
    if (evidence) {
      const punctuation = /[.!?]$/.test(evidence) ? "" : ".";
      return `Đáp án ${answer} đúng vì ${passageKind} nêu “${evidence}”${punctuation} Chi tiết này phù hợp với lựa chọn “${correctOption}”${translatedSuffix}; các lựa chọn còn lại không khớp với thông tin được cung cấp.`;
    }
    return `Đáp án ${answer} đúng vì lựa chọn “${correctOption}”${translatedSuffix} phù hợp nhất với thông tin trong ${passageKind}. Các lựa chọn còn lại không trả lời đúng chi tiết hoặc ý được hỏi.`;
  }
  const tags = new Set(skillTags as QuestionSkillTag[]);
  const reason = skillReason(tags);
  const completed = completedPrompt(source, correctOption);
  const completedSentence = completed
    ? ` Câu hoàn chỉnh là: “${completed}”.`
    : "";
  if (source.part === 5) {
    return `Đáp án ${answer} đúng vì “${correctOption}”${translatedSuffix} phù hợp với ${reason}.${completedSentence} Các lựa chọn còn lại không đáp ứng đồng thời cấu trúc và nghĩa của câu.`;
  }
  if (source.part === 6) {
    if (tags.has("sentence_insertion")) {
      return `Đáp án ${answer} đúng vì câu “${correctOption}”${translatedSuffix} tạo liên kết mạch lạc với thông tin trước và sau chỗ trống. Các lựa chọn còn lại làm đứt mạch ý hoặc đưa vào chi tiết không phù hợp với đoạn văn.`;
    }
    return `Đáp án ${answer} đúng vì “${correctOption}”${translatedSuffix} phù hợp với ${reason} và mạch nghĩa của đoạn văn.${completedSentence} Các lựa chọn còn lại không phù hợp với cấu trúc hoặc ngữ cảnh tại chỗ trống.`;
  }
  return `Đáp án ${answer} là lựa chọn phù hợp nhất với thông tin trong câu hỏi.`;
}

function deriveAltText(
  source: SourceQuestionLike,
  context: QuestionEnrichmentContext,
): Pick<
  QuestionEnrichment,
  "imageAltText" | "imageAltSource" | "imageAltNeedsReview"
> {
  if (!clean(source.image_url)) {
    return {
      imageAltText: null,
      imageAltSource: null,
      imageAltNeedsReview: false,
    };
  }
  if (source.part !== 1) {
    const groupAlt = clean(context.groupImageAltText);
    const prompt = questionStem(source);
    return {
      imageAltText:
        groupAlt ??
        `Đồ họa dùng cho câu ${source.question_number ?? "này"}${prompt ? `: ${prompt}` : "."}`,
      imageAltSource: groupAlt
        ? (context.groupImageAltSource ?? "group_graphic")
        : "context",
      imageAltNeedsReview: groupAlt
        ? Boolean(context.groupImageAltNeedsReview)
        : true,
    };
  }
  const scene = clean(nested(source, ["mirror_profile", "scene_description"]));
  const blueprintScene = clean(
    nested(source, ["mirror_profile", "blueprint", "scene_context"]),
  );
  const sourceScene = scene ?? blueprintScene;
  const description = sourceScene ?? optionFor(source);
  return {
    imageAltText: description ? description.slice(0, 1000) : null,
    imageAltSource: sourceScene ? "source_scene" : "source_correct_caption",
    imageAltNeedsReview: false,
  };
}

function add(
  tags: Set<QuestionSkillTag>,
  ...values: Array<QuestionSkillTag | null | false>
) {
  for (const value of values) {
    if (value) {
      tags.add(value);
    }
  }
}

function comprehensionTags(
  questionText: string,
  explanationText: string,
  tags: Set<QuestionSkillTag>,
): void {
  const vocabularyQuestion =
    /closest in meaning|most similar in meaning|từ .* gần nghĩa/.test(
      questionText,
    );
  const purposeQuestion = /purpose|mục đích/.test(questionText);
  const gistQuestion = /mainly about|main topic|chủ yếu/.test(questionText);
  const inferenceQuestion =
    /imply|infer|most likely|suggested|suy ra|ngụ ý|mean when|ý gì khi|hàm ý khi/.test(
      questionText,
    );

  if (vocabularyQuestion) {
    add(tags, "vocabulary_in_context", "paraphrase");
  }
  if (purposeQuestion) {
    add(tags, "purpose", "gist");
  } else if (gistQuestion) {
    add(tags, "gist");
  } else if (inferenceQuestion) {
    add(tags, "inference", "paraphrase");
  } else if (!vocabularyQuestion) {
    add(tags, "detail");
  }
  if (
    /who most likely (is|are)|who (is|are) the (speaker|listeners)|occupation|profession/.test(
      questionText,
    )
  ) {
    add(tags, "speaker_identity");
  }
  if (
    /what will .* do next|what .* likely do next|next step|tiếp theo/.test(
      questionText,
    )
  ) {
    add(tags, "next_action");
  }
  if (/graphic|visual|map|schedule|chart|look at the/.test(questionText)) {
    add(tags, "graphic_interpretation");
  }
  if (/\bnot\b|except|không được|ngoại trừ/.test(questionText)) {
    add(tags, "negative_detail");
  }
  if (/paraphrase|diễn đạt lại/.test(explanationText)) {
    add(tags, "paraphrase");
  }
}

function grammarTags(text: string, tags: Set<QuestionSkillTag>): void {
  const rules: Array<[RegExp, QuestionSkillTag]> = [
    [
      /ngữ pháp - thì|verb tense|thì (hiện tại|quá khứ|tương lai)/,
      "verb_tense",
    ],
    [/bị động|passive/, "passive_voice"],
    [/động từ nguyên mẫu|infinitive/, "infinitive"],
    [/gerund|danh động từ/, "gerund"],
    [/phân từ|participle/, "participle"],
    [/hòa hợp chủ ngữ|subject.?verb agreement/, "subject_verb_agreement"],
    [/giới từ|preposition/, "preposition"],
    [/liên từ|conjunction/, "conjunction"],
    [/đại từ|pronoun/, "pronoun"],
    [/mệnh đề quan hệ|relative clause/, "relative_clause"],
    [/câu điều kiện|conditional/, "conditional"],
    [/từ hạn định|determiner/, "determiner"],
    [/từ loại|word form/, "word_form"],
    [/danh từ|\bnoun\b/, "noun"],
    [/tính từ|adjective/, "adjective"],
    [/trạng từ|adverb/, "adverb"],
    [/collocation|cụm (từ|cố định)/, "collocation"],
    [
      /từ vựng|vocabulary|phù hợp (nghĩa|ngữ cảnh)|hợp (nghĩa|ngữ cảnh)/,
      "vocabulary",
    ],
  ];
  for (const [pattern, tag] of rules) {
    if (pattern.test(text)) {
      add(tags, tag);
    }
  }
  if (![...tags].some((tag) => tag === "grammar" || tag === "vocabulary")) {
    add(tags, "grammar");
  }
}

function optionValues(source: SourceQuestionLike): string[] {
  return [source.option_a, source.option_b, source.option_c, source.option_d]
    .map(clean)
    .filter((value): value is string => Boolean(value));
}

function inferGrammarTagsFromOptions(
  source: SourceQuestionLike,
  tags: Set<QuestionSkillTag>,
): void {
  const options = optionValues(source).map((value) => value.toLowerCase());
  const answer = (optionFor(source) ?? "").toLowerCase();
  if (!options.length) {
    return;
  }
  const joined = ` ${options.join(" ")} `;
  const allShort = options.every((value) => value.split(/\s+/).length <= 3);
  const prepositions = new Set([
    "about",
    "above",
    "across",
    "after",
    "against",
    "along",
    "among",
    "around",
    "at",
    "before",
    "behind",
    "below",
    "beneath",
    "beside",
    "between",
    "by",
    "despite",
    "during",
    "except",
    "for",
    "from",
    "in",
    "into",
    "of",
    "off",
    "on",
    "onto",
    "over",
    "through",
    "throughout",
    "to",
    "toward",
    "under",
    "until",
    "with",
    "within",
    "without",
  ]);
  const conjunctions = new Set([
    "although",
    "because",
    "before",
    "but",
    "even if",
    "even though",
    "however",
    "if",
    "nor",
    "once",
    "or",
    "otherwise",
    "since",
    "so",
    "therefore",
    "though",
    "unless",
    "until",
    "when",
    "whereas",
    "whether",
    "while",
    "yet",
  ]);
  const pronouns = new Set([
    "he",
    "her",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "it",
    "its",
    "itself",
    "our",
    "ours",
    "ourselves",
    "she",
    "their",
    "theirs",
    "them",
    "themselves",
    "they",
    "us",
    "we",
    "who",
    "whom",
    "whose",
    "you",
    "your",
    "yours",
    "yourself",
  ]);
  const determiners = new Set([
    "a",
    "an",
    "another",
    "any",
    "each",
    "either",
    "every",
    "few",
    "many",
    "much",
    "neither",
    "some",
    "the",
    "this",
    "those",
  ]);

  if (allShort && options.every((value) => prepositions.has(value))) {
    add(tags, "preposition");
  }
  if (allShort && options.every((value) => conjunctions.has(value))) {
    add(tags, "conjunction");
  }
  if (allShort && options.every((value) => pronouns.has(value))) {
    add(tags, "pronoun");
  }
  if (allShort && options.every((value) => determiners.has(value))) {
    add(tags, "determiner");
  }
  if (
    /\b(?:will|would|has|have|had|is|are|was|were|be|been|being|did|does|do)\b/.test(
      joined,
    ) ||
    options.some((value) => /\b\w+(?:ed|ing)\b/.test(value))
  ) {
    add(tags, "verb_tense");
  }
  if (/\b(?:be|been|being)\s+\w+ed\b/.test(answer)) {
    add(tags, "passive_voice");
  }
  if (options.some((value) => /^to\s+\w+/.test(value))) {
    add(tags, "infinitive");
  }
  if (options.some((value) => /^\w+ing$/.test(value))) {
    add(tags, "gerund", "participle");
  }

  const endings = options.map((value) => {
    if (/ly$/.test(value)) return "adverb" as const;
    if (/(?:tion|sion|ment|ness|ity|ance|ence|ship|ist|er|or)$/.test(value))
      return "noun" as const;
    if (/(?:ive|al|ous|ful|less|able|ible|ic|ary|ory)$/.test(value))
      return "adjective" as const;
    return null;
  });
  const detectedForms = new Set(endings.filter(Boolean));
  if (detectedForms.size >= 2) {
    add(tags, "word_form", ...detectedForms);
  } else if (/ly$/.test(answer)) {
    add(tags, "adverb", "word_form");
  } else if (/(?:tion|sion|ment|ness|ity|ance|ence|ship|ist)$/.test(answer)) {
    add(tags, "noun", "word_form");
  } else if (/(?:ive|al|ous|ful|less|able|ible|ic|ary|ory)$/.test(answer)) {
    add(tags, "adjective", "word_form");
  }

  const specificTags = new Set<QuestionSkillTag>([
    "adjective",
    "adverb",
    "collocation",
    "conditional",
    "conjunction",
    "determiner",
    "gerund",
    "infinitive",
    "noun",
    "participle",
    "passive_voice",
    "preposition",
    "pronoun",
    "relative_clause",
    "subject_verb_agreement",
    "verb_tense",
    "word_form",
  ]);
  if (![...tags].some((tag) => specificTags.has(tag))) {
    tags.delete("grammar");
    add(tags, "vocabulary");
  }
}

export function deriveSkillTags(source: SourceQuestionLike): string[] {
  const tags = new Set<QuestionSkillTag>();
  const questionText = questionStem(source).toLowerCase();
  const rawExplanation =
    typeof source.explanation_vi === "string" && source.explanation_vi.trim()
      ? source.explanation_vi.trim()
      : typeof source.explanation_en === "string"
        ? source.explanation_en.trim()
        : "";
  const explanationLead = rawExplanation.split(/\n\s*\n/)[0]!.toLowerCase();
  const grammarText =
    `${clean(source.question_type) ?? ""} ${explanationLead}`.toLowerCase();
  const answer = (optionFor(source) ?? "").toLowerCase();
  const mirrorTense = clean(
    nested(source, ["mirror_profile", "blueprint", "grammar", "tense"]),
  )?.toLowerCase();
  const mirrorTraps = nested(source, ["mirror_profile", "trap_types"]);

  switch (source.part) {
    case 1:
      add(tags, "photo_description");
      if (
        /(?:\b(?:is|are|am)\b|[’'](?:s|re))\s+(?:\w+ly\s+)?\w+ing\b/.test(
          answer,
        )
      ) {
        add(tags, "action", "present_continuous");
      }
      if (
        /\b(?:is|are|has|have) been\b|\bbeing\b|(?:\b(?:is|are)\b|[’'](?:s|re))\s+(?:decorated|filled|prepared|covered|lined|parked|displayed|stacked|arranged|placed|seated|positioned|set|closed|opened|located)\b/.test(
          answer,
        )
      ) {
        add(tags, "passive_voice", "state_description");
      }
      if (
        /\b(in|into|on|onto|at|by|beside|near|behind|under|above|across|along|around|between|from|over|past|through|toward|next to|in front of|border(?:s|ing)?|line(?:s|d)?|overlook(?:s|ing)?|cross(?:es|ing)?)\b/.test(
          answer,
        )
      ) {
        add(tags, "spatial_relation");
      }
      if (/\bthere(?:[’']s|\s+(?:is|are))\b|\b(?:has|have)\b/.test(answer)) {
        add(tags, "object_identification");
      }
      if (
        /\b(?:empty|unoccupied|occupied|open|closed|covered|decorated|displayed|filled|lined|parked|placed|positioned|prepared|seated|stacked|arranged)\b/.test(
          answer,
        )
      ) {
        add(tags, "state_description");
      }
      if (mirrorTense?.includes("present_continuous")) {
        add(tags, "action", "present_continuous");
      }
      if (mirrorTense?.includes("passive")) {
        add(tags, "passive_voice");
      }
      if (Array.isArray(mirrorTraps)) {
        for (const trap of mirrorTraps) {
          if (trap === "wrong_action") add(tags, "action");
          if (trap === "wrong_object") add(tags, "object_identification");
          if (trap === "wrong_location" || trap === "preposition")
            add(tags, "spatial_relation");
        }
      }
      break;
    case 2: {
      add(tags, "question_response");
      const intent = part2Intent(source);
      add(tags, intent.tag);
      if (intent.tag === "yes_no") {
        const option = optionFor(source)?.toLowerCase() ?? "";
        if (!/^(yes|no|yeah|nope|certainly|of course)\b/.test(option)) {
          add(tags, "indirect_response");
        }
      }
      break;
    }
    case 3:
    case 4:
      add(tags, "listening_comprehension");
      comprehensionTags(questionText, rawExplanation.toLowerCase(), tags);
      break;
    case 5:
      add(tags, "sentence_completion");
      grammarTags(grammarText, tags);
      inferGrammarTagsFromOptions(source, tags);
      break;
    case 6: {
      add(tags, "text_completion");
      const options = [
        source.option_a,
        source.option_b,
        source.option_c,
        source.option_d,
      ]
        .map(clean)
        .filter((value): value is string => Boolean(value));
      if (
        options.filter((value) => value.split(/\s+/).length >= 6).length >= 3
      ) {
        add(tags, "sentence_insertion", "cohesion");
      } else {
        grammarTags(grammarText, tags);
        inferGrammarTagsFromOptions(source, tags);
      }
      break;
    }
    case 7:
      add(tags, "reading_comprehension");
      comprehensionTags(questionText, rawExplanation.toLowerCase(), tags);
      break;
    default:
      add(tags, "unclassified");
  }
  return [...tags];
}

export function enrichQuestion(
  source: SourceQuestionLike,
  context: QuestionEnrichmentContext = {},
): QuestionEnrichment {
  const explanationSource = sourceExplanationKind(source);
  const skillTags = deriveSkillTags(source);
  const altText = deriveAltText(source, context);
  return {
    generatedExplanationVi:
      explanationSource === "derived"
        ? deriveExplanation(source, skillTags, context)
        : null,
    explanationSource,
    ...altText,
    imageAltVersion: altText.imageAltText ? IMAGE_ALT_VERSION : null,
    skillTags,
    skillTagVersion: SKILL_TAG_VERSION,
    enrichmentVersion: ENRICHMENT_VERSION,
  };
}
