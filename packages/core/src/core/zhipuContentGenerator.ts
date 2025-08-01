/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  FinishReason,
  Content,
  Part,
  FunctionDeclaration,
} from '@google/genai';
import { ContentGenerator } from './contentGenerator.js';
import { Config } from '../config/config.js';
import { logApiResponse } from '../telemetry/loggers.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import { fetch } from 'undici';

interface ZhipuMessage {
  role: 'user' | 'assistant' | 'system';
  content:
    | string
    | Array<
        | {
            type: 'text';
            text: string;
          }
        | {
            type: 'function_call';
            function_call: {
              name: string;
              arguments: string;
              id?: string;
            };
          }
        | {
            type: 'function_response';
            function_response: {
              name: string;
              content: string;
              id?: string;
            };
          }
      >;
}

interface ZhipuRequest {
  model: string;
  messages: ZhipuMessage[];
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: FunctionDeclaration;
  }>;
}

interface ZhipuResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: ZhipuMessage;
    delta?: {
      role?: string;
      content?: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tools?: Array<{
    type: 'function';
    function: FunctionDeclaration;
  }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface ZhipuEmbeddingRequest {
  model: string;
  input: string | string[];
}

interface ZhipuEmbeddingResponse {
  model: string;
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export class ZhipuContentGenerator implements ContentGenerator {
  private apiKey: string;
  private model: string;
  private embeddingModel: string;
  private config: Config;
  private baseUrl: string;

  constructor(apiKey: string, model: string, config: Config) {
    this.apiKey = apiKey;
    this.model = model;
    this.embeddingModel = 'embedding-2'; // 智谱AI的默认嵌入模型
    this.config = config;
    this.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const startTime = Date.now();

    console.log('ZHIPU: generateContent called');
    console.log('ZHIPU: request.config:', !!request.config);
    if (request.config) {
      console.log('ZHIPU: request.config keys:', Object.keys(request.config));
      console.log('ZHIPU: request.config.tools:', !!request.config.tools);
      if (request.config.tools) {
        console.log(
          'ZHIPU: request.config.tools type:',
          typeof request.config.tools,
        );
        console.log(
          'ZHIPU: request.config.tools:',
          JSON.stringify(request.config.tools, null, 2),
        );
      }
    }

    try {
      const zhipuRequest: ZhipuRequest = {
        model: this.model,
        messages: this.convertToZhipuFormat(request),
        stream: false,
        // 添加工具声明
        tools: this.extractToolsFromRequest(request),
      };

      // 打印调试信息，确认工具是否正确传递
      if (zhipuRequest.tools) {
        console.log(
          `ZHIPU: Streaming - Sending ${zhipuRequest.tools.length} tools to API`,
        );
        zhipuRequest.tools.forEach((tool, index) => {
          console.log(
            `ZHIPU: Streaming - Tool ${index + 1}: ${tool.function.name}`,
          );
        });
      } else {
        console.log('ZHIPU: Streaming - No tools to send to API');
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(zhipuRequest),
      });

      if (!response.ok) {
        throw new Error(
          `Zhipu API error: ${response.status} ${response.statusText}`,
        );
      }

      const zhipuResponse = (await response.json()) as ZhipuResponse;
      const durationMs = Date.now() - startTime;

      // 添加调试信息
      if (zhipuResponse.tool_calls && zhipuResponse.tool_calls.length > 0) {
        console.log(
          `ZHIPU: Received ${zhipuResponse.tool_calls.length} tool calls from API`,
        );
        zhipuResponse.tool_calls.forEach((toolCall, index) => {
          console.log(
            `ZHIPU: Tool call ${index + 1}: ${toolCall.function.name}`,
          );
        });
      } else {
        console.log('ZHIPU: No tool calls received from API');
      }

      // 创建一个基础的GenerateContentResponse对象
      const generateContentResponse = new GenerateContentResponse();
      generateContentResponse.responseId = zhipuResponse.id;
      generateContentResponse.modelVersion = zhipuResponse.model;

      generateContentResponse.candidates = zhipuResponse.choices.map(
        (choice) => ({
          index: choice.index,
          content: {
            role: 'model',
            parts: this.convertZhipuResponseToParts(
              choice.message?.content,
              zhipuResponse.tool_calls,
            ),
          },
          finishReason: this.mapZhipuFinishReason(choice.finish_reason),
        }),
      );

      // Add usage metadata if available
      if (zhipuResponse.usage) {
        generateContentResponse.usageMetadata = {
          promptTokenCount: zhipuResponse.usage.prompt_tokens,
          candidatesTokenCount: zhipuResponse.usage.completion_tokens,
          totalTokenCount: zhipuResponse.usage.total_tokens,
        };
      }

      // Log API response event for UI telemetry
      const responseEvent = new ApiResponseEvent(
        this.model,
        durationMs,
        `zhipu-${Date.now()}`,
        this.config.getContentGeneratorConfig()?.authType,
        generateContentResponse.usageMetadata,
      );
      logApiResponse(this.config, responseEvent);

      return generateContentResponse;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Log API error event for UI telemetry
      const errorEvent = new ApiResponseEvent(
        this.model,
        durationMs,
        `zhipu-${Date.now()}`,
        this.config.getContentGeneratorConfig()?.authType,
        undefined,
        undefined,
        errorMessage,
      );
      logApiResponse(this.config, errorEvent);

      throw new Error(`Zhipu API error: ${errorMessage}`);
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const startTime = Date.now();

    console.log('ZHIPU: generateContentStream called');
    console.log('ZHIPU: request.config:', !!request.config);
    if (request.config) {
      console.log('ZHIPU: request.config keys:', Object.keys(request.config));
      console.log('ZHIPU: request.config.tools:', !!request.config.tools);
      if (request.config.tools) {
        console.log(
          'ZHIPU: request.config.tools type:',
          typeof request.config.tools,
        );
        console.log(
          'ZHIPU: request.config.tools:',
          JSON.stringify(request.config.tools, null, 2),
        );
      }
    }

    try {
      const zhipuRequest: ZhipuRequest = {
        model: this.model,
        messages: this.convertToZhipuFormat(request),
        stream: true, // 启用流式传输
        // 添加工具声明
        tools: this.extractToolsFromRequest(request),
      };

      // 打印调试信息，确认工具是否正确传递
      if (zhipuRequest.tools) {
        console.log(
          'ZHIPU Streaming Tools being sent:',
          JSON.stringify(zhipuRequest.tools, null, 2),
        );
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(zhipuRequest),
      });

      if (!response.ok) {
        throw new Error(
          `Zhipu API error: ${response.status} ${response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error('Zhipu API response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const streamGenerator = async function* (this: ZhipuContentGenerator) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                  const zhipuResponse = JSON.parse(data) as ZhipuResponse;

                  // 添加调试信息
                  if (
                    zhipuResponse.tool_calls &&
                    zhipuResponse.tool_calls.length > 0
                  ) {
                    console.log(
                      `ZHIPU: Streaming - Received ${zhipuResponse.tool_calls.length} tool calls from API`,
                    );
                    zhipuResponse.tool_calls.forEach((toolCall, index) => {
                      console.log(
                        `ZHIPU: Streaming - Tool call ${index + 1}: ${toolCall.function.name}`,
                      );
                    });
                  }

                  // Convert to GenerateContentResponse format
                  const generateContentResponse = new GenerateContentResponse();
                  generateContentResponse.responseId = zhipuResponse.id;
                  generateContentResponse.modelVersion = zhipuResponse.model;

                  generateContentResponse.candidates =
                    zhipuResponse.choices.map((choice) => {
                      const delta = choice.delta;
                      return {
                        index: choice.index,
                        content: {
                          role: 'model',
                          parts: this.convertZhipuContentToParts(
                            delta?.content,
                          ),
                        },
                        finishReason: this.mapZhipuFinishReason(
                          choice.finish_reason,
                        ),
                      };
                    });

                  // Add usage metadata if available
                  if (zhipuResponse.usage) {
                    generateContentResponse.usageMetadata = {
                      promptTokenCount: zhipuResponse.usage.prompt_tokens,
                      candidatesTokenCount:
                        zhipuResponse.usage.completion_tokens,
                      totalTokenCount: zhipuResponse.usage.total_tokens,
                    };
                  }

                  yield generateContentResponse;
                } catch (parseError) {
                  console.error(
                    'Error parsing Zhipu streaming response:',
                    parseError,
                  );
                }
              }
            }
          }

          // Process any remaining buffer
          if (buffer.trim()) {
            try {
              const zhipuResponse = JSON.parse(buffer.trim()) as ZhipuResponse;

              const generateContentResponse = new GenerateContentResponse();
              generateContentResponse.responseId = zhipuResponse.id;
              generateContentResponse.modelVersion = zhipuResponse.model;

              generateContentResponse.candidates = zhipuResponse.choices.map(
                (choice) => ({
                  index: choice.index,
                  content: {
                    role: 'model',
                    parts: this.convertZhipuResponseToParts(
                      choice.message?.content,
                      zhipuResponse.tool_calls,
                    ),
                  },
                  finishReason: this.mapZhipuFinishReason(choice.finish_reason),
                }),
              );

              yield generateContentResponse;
            } catch (parseError) {
              console.error('Error parsing final Zhipu response:', parseError);
            }
          }
        } finally {
          reader.releaseLock();
        }
      }.bind(this);

      return streamGenerator();
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Log API error event for UI telemetry
      const errorEvent = new ApiResponseEvent(
        this.model,
        durationMs,
        `zhipu-${Date.now()}`,
        this.config.getContentGeneratorConfig()?.authType,
        undefined,
        undefined,
        errorMessage,
      );
      logApiResponse(this.config, errorEvent);

      throw new Error(`Zhipu API streaming error: ${errorMessage}`);
    }
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // 智谱AI没有专门的token计数API，我们返回一个估算值
    // 这里简单地返回一个固定值，实际应用中可能需要更复杂的估算逻辑
    return {
      totalTokens: 0,
    };
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    try {
      let input: string | string[] = '';

      // 处理不同的输入格式
      if (Array.isArray(request.contents)) {
        input = request.contents.map((content) => {
          if (typeof content === 'string') {
            return content;
          } else if (this.isContentWithParts(content)) {
            return content.parts
              .map((part) =>
                this.isTextPart(part)
                  ? part.text
                  : typeof part === 'string'
                    ? part
                    : '',
              )
              .join('');
          }
          return '';
        });
      } else {
        if (typeof request.contents === 'string') {
          input = request.contents;
        } else if (this.isContentWithParts(request.contents)) {
          input = request.contents.parts
            .map((part) =>
              this.isTextPart(part)
                ? part.text
                : typeof part === 'string'
                  ? part
                  : '',
            )
            .join('');
        }
      }

      const zhipuRequest: ZhipuEmbeddingRequest = {
        model: this.embeddingModel,
        input: input,
      };

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(zhipuRequest),
      });

      if (!response.ok) {
        throw new Error(
          `Zhipu Embedding API error: ${response.status} ${response.statusText}`,
        );
      }

      const zhipuResponse = (await response.json()) as ZhipuEmbeddingResponse;

      return {
        embeddings: zhipuResponse.data.map((item) => ({
          values: item.embedding,
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Zhipu Embedding API error: ${errorMessage}`);
    }
  }

  private convertToZhipuFormat(
    request: GenerateContentParameters,
  ): ZhipuMessage[] {
    const messages: ZhipuMessage[] = [];

    // Handle contents
    if (Array.isArray(request.contents)) {
      for (const content of request.contents) {
        if (typeof content === 'string') {
          messages.push({ role: 'user', content });
        } else if ('role' in content && 'parts' in content) {
          // Check if this content has function calls or responses
          const functionCalls: any[] = [];
          const functionResponses: any[] = [];
          const textParts: string[] = [];

          for (const part of content.parts || []) {
            if (typeof part === 'string') {
              textParts.push(part);
            } else if ('text' in part && part.text) {
              textParts.push(part.text);
            } else if ('functionCall' in part && part.functionCall) {
              functionCalls.push(part.functionCall);
            } else if ('functionResponse' in part && part.functionResponse) {
              functionResponses.push(part.functionResponse);
            }
          }

          // Handle text content
          if (textParts.length > 0) {
            const contentText = textParts.join('');
            const role =
              content.role === 'user'
                ? 'user'
                : content.role === 'model'
                  ? 'assistant'
                  : 'system';
            messages.push({ role, content: contentText });
          }

          // Handle function calls
          if (functionCalls.length > 0) {
            const functionCallParts = functionCalls.map((fc) => ({
              type: 'function_call' as const,
              function_call: {
                name: fc.name,
                arguments: JSON.stringify(fc.args),
                id: fc.id,
              },
            }));

            const role =
              content.role === 'user'
                ? 'user'
                : content.role === 'model'
                  ? 'assistant'
                  : 'system';
            messages.push({ role, content: functionCallParts });
          }

          // Handle function responses
          if (functionResponses.length > 0) {
            const functionResponseParts = functionResponses.map((fr) => ({
              type: 'function_response' as const,
              function_response: {
                name: fr.name,
                content:
                  typeof fr.response === 'string'
                    ? fr.response
                    : JSON.stringify(fr.response),
                id: fr.id,
              },
            }));

            const role =
              content.role === 'user'
                ? 'user'
                : content.role === 'model'
                  ? 'assistant'
                  : 'system';
            messages.push({ role, content: functionResponseParts });
          }
        }
      }
    }

    return messages;
  }

  private convertZhipuResponseToParts(
    content: string | Array<any> | undefined,
    toolCalls?: Array<any>,
  ): Part[] {
    const parts: Part[] = [];

    // 处理文本内容
    if (content) {
      if (typeof content === 'string') {
        parts.push({ text: content });
      } else if (Array.isArray(content)) {
        // 如果是数组，处理不同类型的元素
        for (const item of content) {
          if (item.type === 'text') {
            parts.push({ text: item.text });
          } else if (item.type === 'function_call') {
            parts.push({
              functionCall: {
                id: item.function_call.id,
                name: item.function_call.name,
                args: JSON.parse(item.function_call.arguments),
              },
            });
          } else if (item.type === 'function_response') {
            parts.push({
              functionResponse: {
                id: item.function_response.id,
                name: item.function_response.name,
                response: item.function_response.content,
              },
            });
          }
        }
      }
    }

    // 处理工具调用
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        try {
          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        } catch (error) {
          console.error('Error parsing tool call arguments:', error);
          // 添加一个错误处理的functionCall
          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args: {},
            },
          });
        }
      }
    }

    return parts;
  }

  private convertZhipuContentToParts(
    content: string | Array<any> | undefined,
  ): Part[] {
    return this.convertZhipuResponseToParts(content, undefined);
  }

  private extractToolsFromRequest(
    request: GenerateContentParameters,
  ): Array<{ type: 'function'; function: FunctionDeclaration }> | undefined {
    // 检查request.config是否存在以及是否有tools属性
    console.log(
      'ZHIPU: extractToolsFromRequest - request.config:',
      !!request.config,
    );
    if (request.config) {
      console.log('ZHIPU: request.config keys:', Object.keys(request.config));
      console.log('ZHIPU: request.config.tools:', !!request.config.tools);
    }

    if (!request.config || !request.config.tools) {
      console.log('ZHIPU: No tools found in request config');
      return undefined;
    }

    // 检查tools是否具有functionDeclarations属性
    const tools = request.config.tools as any;
    console.log('ZHIPU: tools type:', typeof tools);
    console.log('ZHIPU: tools:', JSON.stringify(tools, null, 2));

    if (
      !tools.functionDeclarations ||
      !Array.isArray(tools.functionDeclarations)
    ) {
      console.log('ZHIPU: No functionDeclarations found in tools');
      console.log(
        'ZHIPU: tools.functionDeclarations:',
        tools.functionDeclarations,
      );
      return undefined;
    }

    // 将工具声明转换为ZHIPU AI所需的格式
    console.log(
      `ZHIPU: Converting ${tools.functionDeclarations.length} function declarations`,
    );
    const zhipuTools = tools.functionDeclarations.map(
      (funcDecl: FunctionDeclaration, index: number) => {
        // 确保functionDeclaration格式正确
        console.log(`ZHIPU: Processing function ${index + 1}:`, funcDecl.name);
        console.log(
          `ZHIPU: Function ${index + 1} description:`,
          funcDecl.description,
        );
        console.log(
          `ZHIPU: Function ${index + 1} parameters:`,
          JSON.stringify(funcDecl.parameters, null, 2),
        );

        const toolFunction = {
          name: funcDecl.name,
          description: funcDecl.description || '',
          parameters: funcDecl.parameters || {},
        };

        console.log(`ZHIPU: Adding tool: ${toolFunction.name}`);
        return {
          type: 'function' as const,
          function: toolFunction,
        };
      },
    );

    console.log(`ZHIPU: Total tools extracted: ${zhipuTools.length}`);
    console.log(
      `ZHIPU: Final zhipuTools:`,
      JSON.stringify(zhipuTools, null, 2),
    );
    return zhipuTools;
  }

  private mapZhipuFinishReason(zhipuReason: string): FinishReason | undefined {
    switch (zhipuReason) {
      case 'stop':
        return FinishReason.STOP;
      case 'length':
        return FinishReason.MAX_TOKENS;
      case 'content_filter':
        return FinishReason.SAFETY;
      default:
        return FinishReason.FINISH_REASON_UNSPECIFIED;
    }
  }

  private isContentWithParts(
    content: Content | Part | string,
  ): content is Content & { parts: Part[] } {
    return (
      typeof content === 'object' && content !== null && 'parts' in content
    );
  }

  private isTextPart(part: Part): part is { text: string } {
    return typeof part === 'object' && part !== null && 'text' in part;
  }
}
