import { buildElicitationResponseContent } from "./client.js";

/** Cache live inputs by session/interaction identity so streaming preserves drafts and focus. */
export function createInteractionRenderer(client, { node, button, report, display }) {
  const interactionNodes = new Map();
  return (snapshot) => {
    const elements = [];
    const activeInteractions = new Set();
    for (const interaction of snapshot?.pendingInteractions ?? []) {
      const key = `${client.sessionId}:${interaction.interactionId}`;
      activeInteractions.add(key);
      let box = interactionNodes.get(key);
      if (box) {
        elements.push(box);
        continue;
      }
      box = node("div", undefined, "interaction text-ui-base");
      const payload = interaction.payload;
      const interactionSession = client.sessionId;
      box.append(node("p", payload.summary ?? payload.prompt ?? display(payload)));
      if (payload.kind === "permission")
        box.append(node("pre", display(payload.detail), "text-ui-sm"));
      if (payload.questions?.length) {
        const questions = payload.questions.map((question, index) => ({
          ...question,
          key: `answer_${index}`,
        }));
        const drafts = {};
        for (const question of questions) {
          const field = node("fieldset", undefined, "text-ui-base");
          field.append(node("legend", question.question));
          const draft = { selectedValues: [], customAnswer: "" };
          drafts[question.key] = draft;
          for (const option of question.options) {
            const label = node("label", undefined, "text-ui-base");
            const choice = node("input");
            choice.type = question.multiSelect ? "checkbox" : "radio";
            choice.name = `${key}:${question.key}`;
            choice.value = option.value;
            choice.addEventListener("change", () => {
              draft.selectedValues = [...field.querySelectorAll("input:checked")].map(
                (input) => input.value,
              );
            });
            label.append(choice, document.createTextNode(option.label));
            if (option.description) label.append(node("small", option.description));
            field.append(label);
          }
          const custom = node("textarea", undefined, "text-ui-base");
          custom.placeholder = "Свой ответ (необязательно)";
          custom.addEventListener("input", () => {
            draft.customAnswer = custom.value;
          });
          field.append(custom);
          box.append(field);
        }
        box.append(
          button("Ответить", () =>
            client.command(
              "resolveInteraction",
              {
                interactionId: interaction.interactionId,
                answer: {
                  action: "accept",
                  content: buildElicitationResponseContent(questions, drafts),
                },
              },
              interactionSession,
            ),
          ),
          button("Отменить", () =>
            client.command(
              "resolveInteraction",
              { interactionId: interaction.interactionId, answer: { action: "cancel" } },
              interactionSession,
            ),
          ),
        );
      } else
        for (const option of payload.options ?? [])
          box.append(
            button(option.label, () =>
              client.command(
                "resolveInteraction",
                { interactionId: interaction.interactionId, answer: { optionId: option.optionId } },
                interactionSession,
              ),
            ),
          );
      if (payload.freeText && !payload.questions?.length) {
        const input = node("input", undefined, "text-ui-base");
        input.type = payload.sensitive ? "password" : "text";
        input.setAttribute("aria-label", "Ответ агенту");
        box.append(
          input,
          button("Ответить", () =>
            client.command(
              "resolveInteraction",
              { interactionId: interaction.interactionId, answer: { freeText: input.value } },
              interactionSession,
            ),
          ),
        );
      }
      if (interaction.autoResolution) {
        const snooze = () =>
          void client
            .command(
              "snoozeAskUserQuestionAutoResolution",
              { interactionId: interaction.interactionId },
              interactionSession,
            )
            .catch(report);
        box.addEventListener("focusin", snooze, { once: true });
      }
      interactionNodes.set(key, box);
      elements.push(box);
    }
    for (const key of interactionNodes.keys())
      if (!activeInteractions.has(key)) interactionNodes.delete(key);
    return elements;
  };
}
