import { describe, expect, it } from "vitest";
import {
  ENRICHMENT_VERSION,
  enrichQuestion,
  isOptionListTranslation,
} from "../src/shared/question-enrichment.js";

describe("question enrichment", () => {
  it("derives Part 1 alt text, explanation, and visual skills", () => {
    const result = enrichQuestion({
      part: 1,
      image_url: "https://cdn.example/photo.png",
      correct_answer: "B",
      option_a: "The woman is wiping a table.",
      option_b: "The woman is holding a glass.",
      option_c: "The woman is pouring a drink.",
      option_d: "The woman is paying a bill.",
      dich_nghia:
        "(A) Người phụ nữ đang lau bàn. (B) Người phụ nữ đang cầm một chiếc ly. (C) Người phụ nữ đang rót đồ uống. (D) Người phụ nữ đang thanh toán.",
      mirror_profile: {
        scene_description:
          "A woman is seated at a restaurant table holding a glass.",
        trap_types: ["wrong_action", "wrong_object"],
        blueprint: { grammar: { tense: "present_continuous" } },
      },
    });

    expect(result.imageAltText).toBe(
      "A woman is seated at a restaurant table holding a glass.",
    );
    expect(result.generatedExplanationVi).toContain("Đáp án B đúng");
    expect(result.skillTags).toEqual(
      expect.arrayContaining([
        "photo_description",
        "action",
        "present_continuous",
        "object_identification",
      ]),
    );
    expect(result.enrichmentVersion).toBe(ENRICHMENT_VERSION);
  });

  it("falls back to the correct Part 1 option for image alt text", () => {
    const result = enrichQuestion({
      part: 1,
      image_url: "1.png",
      correct_answer: "A",
      option_a: "Some bags have been set on the floor.",
      option_b: "The woman is facing a fireplace.",
    });

    expect(result.imageAltText).toBe("Some bags have been set on the floor.");
    expect(result.imageAltSource).toBe("source_correct_caption");
    expect(result.imageAltNeedsReview).toBe(false);
  });

  it("recognizes contracted Part 1 actions and static scene states", () => {
    expect(
      enrichQuestion({
        part: 1,
        correct_answer: "A",
        option_a: "She’s inserting a cord into an outlet.",
      }).skillTags,
    ).toEqual(
      expect.arrayContaining([
        "action",
        "present_continuous",
        "spatial_relation",
      ]),
    );
    expect(
      enrichQuestion({
        part: 1,
        correct_answer: "B",
        option_b: "A metal bench is unoccupied.",
      }).skillTags,
    ).toEqual(expect.arrayContaining(["state_description"]));
  });

  it("classifies Part 2 response intent and generates an explanation", () => {
    const result = enrichQuestion({
      part: 2,
      question_text: "Where is the parking garage?",
      correct_answer: "B",
      option_a: "The local park is nice.",
      option_b: "Behind the office building.",
      option_c: "During his commute.",
    });

    expect(result.skillTags).toEqual(["question_response", "location"]);
    expect(result.generatedExplanationVi).toContain("địa điểm");
  });

  it("ignores Part 2 speaker labels when classifying intent", () => {
    expect(
      enrichQuestion({
        part: 2,
        question_text: "W-Am: Can't you deliver these orders today?\nM-Au:",
        correct_answer: "C",
        option_c: "Yes, I can.",
      }).skillTags,
    ).toEqual(["question_response", "yes_no"]);
  });

  it("does not infer Part 2 intent from translated answer choices", () => {
    const result = enrichQuestion({
      part: 2,
      dich_nghia:
        "Bạn đã gửi báo cáo chưa? (A) Ở đâu cũng được. (B) Rồi, sáng nay. (C) Khoảng hai trang.",
      correct_answer: "B",
      option_a: "Anywhere is fine.",
      option_b: "Yes, this morning.",
      option_c: "About two pages.",
    });

    expect(result.skillTags).toEqual(["question_response", "yes_no"]);
  });

  it("preserves source explanations instead of generating replacements", () => {
    const result = enrichQuestion({
      part: 2,
      question_text: "When does the store close?",
      correct_answer: "A",
      option_a: "At nine o'clock.",
      explanation_vi: "Câu hỏi hỏi thời gian đóng cửa.",
    });

    expect(result.explanationSource).toBe("source");
    expect(result.generatedExplanationVi).toBeNull();
  });

  it("keeps answer translations separate and generates a real explanation", () => {
    const result = enrichQuestion({
      part: 6,
      question_text: "The consultant has ------- the final report.",
      correct_answer: "B",
      option_a: "prepare",
      option_b: "prepared",
      option_c: "preparing",
      option_d: "preparation",
      dich_nghia_dap_an:
        "(A) chuẩn bị (B) đã chuẩn bị (C) đang chuẩn bị (D) sự chuẩn bị",
    });

    expect(result.explanationSource).toBe("derived");
    expect(result.generatedExplanationVi).toContain("Đáp án B đúng");
    expect(result.generatedExplanationVi).not.toBe(
      "(A) chuẩn bị (B) đã chuẩn bị (C) đang chuẩn bị (D) sự chuẩn bị",
    );
    expect(result.skillTags).toEqual(
      expect.arrayContaining(["text_completion", "verb_tense"]),
    );
  });

  it("copies reviewed group graphic alt text onto graphic questions", () => {
    const result = enrichQuestion(
      {
        part: 3,
        question_number: 62,
        question_text: "Look at the graphic. Where is the woman?",
        image_url: "graphic.png",
        correct_answer: "A",
        option_a: "At the station",
        explanation_vi: "Thông tin được đối chiếu với đồ họa.",
      },
      {
        groupImageAltText: "Bản đồ có nhà ga ở phía bắc công viên.",
        groupImageAltSource: "ocr",
        groupImageAltNeedsReview: false,
      },
    );

    expect(result.imageAltText).toBe("Bản đồ có nhà ga ở phía bắc công viên.");
    expect(result.imageAltSource).toBe("ocr");
    expect(result.imageAltNeedsReview).toBe(false);
  });

  it("classifies comprehension and grammar skills", () => {
    expect(
      enrichQuestion({
        part: 3,
        question_text: "What is the conversation mainly about?",
        explanation_vi: "Paraphrase: delivery = shipment",
        correct_answer: "A",
        option_a: "A delayed shipment",
      }).skillTags,
    ).toEqual(
      expect.arrayContaining(["listening_comprehension", "gist", "paraphrase"]),
    );
    expect(
      enrichQuestion({
        part: 5,
        question_text: "The report ------- tomorrow.",
        question_type: "Ngữ pháp - thì",
        correct_answer: "C",
        option_c: "will be submitted",
      }).skillTags,
    ).toEqual(
      expect.arrayContaining(["sentence_completion", "grammar", "verb_tense"]),
    );
  });

  it("recognizes sentence insertion and reading vocabulary questions", () => {
    expect(
      enrichQuestion({
        part: 6,
        correct_answer: "A",
        option_a: "The renovated lobby will reopen to visitors next Monday.",
        option_b: "Employees should therefore use the entrance on King Street.",
        option_c: "This work was originally scheduled for the previous month.",
        option_d:
          "Additional information is available from the facilities office.",
      }).skillTags,
    ).toEqual(
      expect.arrayContaining([
        "text_completion",
        "sentence_insertion",
        "cohesion",
      ]),
    );
    expect(
      enrichQuestion({
        part: 7,
        question_text: 'The word "issue" is closest in meaning to',
        correct_answer: "B",
        option_b: "problem",
      }).skillTags,
    ).toEqual(
      expect.arrayContaining([
        "reading_comprehension",
        "vocabulary_in_context",
        "paraphrase",
      ]),
    );
  });

  it("replaces a mislabeled option translation with an evidence-based explanation", () => {
    const source = {
      part: 7,
      question_text: "Why was the e-mail sent?",
      correct_answer: "A",
      option_a: "To confirm a change to a subscription",
      option_b: "To request a refund",
      option_c: "To announce a delivery delay",
      option_d: "To advertise a new service",
      explanation_en:
        "Tại sao e-mail được gửi?\nA. Để xác nhận thay đổi gói đăng ký\nB. Để yêu cầu hoàn tiền\nC. Để thông báo giao hàng chậm\nD. Để quảng cáo dịch vụ mới",
    };

    expect(isOptionListTranslation(source)).toBe(true);
    const result = enrichQuestion(source, {
      groupContentText:
        "Your subscription has now been changed to our Family plan, as requested.",
    });
    expect(result.explanationSource).toBe("derived");
    expect(result.generatedExplanationVi).toContain(
      "Your subscription has now been changed",
    );
    expect(result.generatedExplanationVi).toContain(
      "Để xác nhận thay đổi gói đăng ký",
    );
  });

  it("uses the quoted source word as evidence for vocabulary questions", () => {
    const result = enrichQuestion(
      {
        part: 7,
        question_text: 'The word "terms" is closest in meaning to',
        correct_answer: "B",
        option_a: "payments",
        option_b: "conditions",
        option_c: "meetings",
        option_d: "documents",
        explanation_en:
          "Từ terms gần nghĩa nhất với từ nào?\nA. khoản thanh toán\nB. điều kiện\nC. cuộc họp\nD. tài liệu",
      },
      {
        groupContentText:
          "Please review the terms of the agreement before signing it.",
      },
    );

    expect(result.generatedExplanationVi).toContain(
      "Please review the terms of the agreement",
    );
  });
});
