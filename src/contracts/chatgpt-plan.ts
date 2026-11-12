export const CHATGPT_PLAN_PROVIDER = 'openai-chatgpt';

export type ChatGPTSignIn = {
  id: string;
  status: 'waiting' | 'connected' | 'failed';
  authorizationUrl?: string;
  error?: string;
};
