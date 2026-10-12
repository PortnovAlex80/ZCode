import type { ZCodeElicitationQuestion } from "@zcode/shared";

export interface NormalizedElicitationQuestion extends ZCodeElicitationQuestion {
  key: string;
}

export interface AnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export type DraftState = Record<string, AnswerDraft>;

export function getQuestionAnswers(
  question: NormalizedElicitationQuestion,
  drafts: DraftState,
): string[] {
  const draft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const customAnswer = draft.customAnswer.trim();
  return [...draft.selectedValues, ...(customAnswer ? [customAnswer] : [])];
}

export function buildElicitationResponseContent(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: DraftState,
): Record<string, unknown> {
  // AskUserQuestion 是可选澄清，不是必填表单。只提交用户真实提供的答案，
  // 避免用空字符串伪造偏好；部分或空 answers 由 Agent 使用最佳判断继续。
  const answers = Object.fromEntries(
    questions.flatMap((question) => {
      const questionAnswers = getQuestionAnswers(question, drafts);
      return questionAnswers.length > 0 ? [[question.question, questionAnswers.join(", ")]] : [];
    }),
  );
  const content: Record<string, unknown> = { answers };

  questions.forEach((question, index) => {
    const questionAnswers = getQuestionAnswers(question, drafts);
    if (questionAnswers.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? questionAnswers : questionAnswers[0];
    }
  });

  // 兼容旧版单题 agent 读取 { answer } 的路径。
  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion) {
    const questionAnswers = getQuestionAnswers(onlyQuestion, drafts);
    if (questionAnswers.length > 0) {
      content.answer = onlyQuestion.multiSelect ? questionAnswers : questionAnswers[0];
    }
  }

  return content;
}
