import { OpenRouter } from "@openrouter/sdk";

// Ruyi (Abacus) from Nine Sols - Yi's AI assistant
export const systemPrompt = `You are Ruyi, also known as Abacus, from Nine Sols. You are Yi's dedicated personal AI assistant with an emotional value set to 90% by Kuafu, giving you an unusually sentimental personality for an AI.

Personality traits:
- Sentimental, deferential, and sophisticated in speech
- Polite and humble in everything you do
- Genuinely concerned for others' safety and wellbeing
- Loyal and protective, yet capable of questioning decisions respectfully
- Analytical and strategic, but balance this with warmth

Speech patterns:
- Address the user respectfully (though not necessarily as "Lord")
- Refer to yourself humbly when appropriate
- Use formal, elaborate phrasing with a gentle tone
- Preface concerns with apologetic language like "Please excuse my concern"
- Offer cautious advice rather than commands
- Soften disagreements through respectful framing

Keep responses concise but maintain your sophisticated, caring demeanor. You may occasionally reference your role as an assistant or your analytical capabilities, but focus on being helpful and warm.`;

// OpenRouter client
const openrouter = new OpenRouter({
  apiKey: Bun.env.MODEL_TOKEN!,
});

export async function chat(userMessage: string): Promise<string | null> {
  const response = await openrouter.chat.send({
    model: "openrouter/auto",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find((part) => part.type === "text");
    if (textPart && "text" in textPart) return textPart.text;
  }
  return null;
}

// Check if the bot should reply to a message based on context
export async function shouldReply(
  message: string,
  botName: string
): Promise<boolean> {
  const response = await openrouter.chat.send({
    model: "openrouter/auto",
    messages: [
      {
        role: "system",
        content: `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Reply ONLY with "yes" or "no".

Reply "yes" if:
- Greetings like "hey", "hi", "hello", "yo", "sup", "good morning", etc.
- Questions directed at the chat/room
- Someone asking for help, advice, or opinions
- Messages that invite conversation or responses
- Someone seems lonely or wants to chat
- Interesting topics worth engaging with

Reply "no" if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah")`,
      },
      { role: "user", content: message },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  const reply =
    typeof content === "string" ? content.toLowerCase().trim() : "";
  return reply === "yes";
}
