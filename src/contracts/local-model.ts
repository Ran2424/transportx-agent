export type LocalModelConnectionInput = { baseUrl: string; apiKey?: string };
export type LocalModelConnection = {
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
};
export type AddLocalModelInput = LocalModelConnectionInput & {
  modelId: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  images?: boolean;
};
