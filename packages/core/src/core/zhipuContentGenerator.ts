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
  } from '@google/genai';
  import { ContentGenerator } from './contentGenerator.js';
  import { Config } from '../config/config.js';
  import { logApiResponse } from '../telemetry/loggers.js';
  import { ApiResponseEvent } from '../telemetry/types.js';
  import { fetch } from 'undici';
  
  interface ZhipuMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
  }
  
  interface ZhipuRequest {
    model: string;
    messages: ZhipuMessage[];
    stream?: boolean;
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
  
      try {
        const zhipuRequest: ZhipuRequest = {
          model: this.model,
          messages: this.convertToZhipuFormat(request),
          stream: false,
        };
  
        const response = await fetch(
          `${this.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(zhipuRequest),
          },
        );
  
        if (!response.ok) {
          throw new Error(`Zhipu API error: ${response.status} ${response.statusText}`);
        }
  
        const zhipuResponse = await response.json() as ZhipuResponse;
        const durationMs = Date.now() - startTime;
  
        // 创建一个基础的GenerateContentResponse对象
        const generateContentResponse = new GenerateContentResponse();
        generateContentResponse.responseId = zhipuResponse.id;
        generateContentResponse.modelVersion = zhipuResponse.model;
        generateContentResponse.candidates = zhipuResponse.choices.map((choice) => ({
          index: choice.index,
          content: {
            role: 'model',
            parts: [{ text: choice.message?.content || '' }],
          },
          finishReason: this.mapZhipuFinishReason(choice.finish_reason),
        }));
  
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
        const errorMessage = error instanceof Error ? error.message : String(error);
  
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
  
      try {
        const zhipuRequest: ZhipuRequest = {
          model: this.model,
          messages: this.convertToZhipuFormat(request),
          stream: true, // 启用流式传输
        };
  
        const response = await fetch(
          `${this.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(zhipuRequest),
          },
        );
  
        if (!response.ok) {
          throw new Error(`Zhipu API error: ${response.status} ${response.statusText}`);
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
                    const durationMs = Date.now() - startTime;
  
                    // Convert to GenerateContentResponse format
                    const generateContentResponse = new GenerateContentResponse();
                    generateContentResponse.responseId = zhipuResponse.id;
                    generateContentResponse.modelVersion = zhipuResponse.model;
                    generateContentResponse.candidates = zhipuResponse.choices.map((choice) => {
                      const delta = choice.delta;
                      return {
                        index: choice.index,
                        content: {
                          role: 'model',
                          parts: [{ text: delta?.content || '' }],
                        },
                        finishReason: this.mapZhipuFinishReason(choice.finish_reason),
                      };
                    });
  
                    // Add usage metadata if available
                    if (zhipuResponse.usage) {
                      generateContentResponse.usageMetadata = {
                        promptTokenCount: zhipuResponse.usage.prompt_tokens,
                        candidatesTokenCount: zhipuResponse.usage.completion_tokens,
                        totalTokenCount: zhipuResponse.usage.total_tokens,
                      };
                    }
  
                    yield generateContentResponse;
                  } catch (parseError) {
                    console.error('Error parsing Zhipu streaming response:', parseError);
                  }
                }
              }
            }
  
            // Process any remaining buffer
            if (buffer.trim()) {
              try {
                const zhipuResponse = JSON.parse(buffer.trim()) as ZhipuResponse;
                const durationMs = Date.now() - startTime;
  
                const generateContentResponse = new GenerateContentResponse();
                generateContentResponse.responseId = zhipuResponse.id;
                generateContentResponse.modelVersion = zhipuResponse.model;
                generateContentResponse.candidates = zhipuResponse.choices.map((choice) => ({
                  index: choice.index,
                  content: {
                    role: 'model',
                    parts: [{ text: choice.message?.content || '' }],
                  },
                  finishReason: this.mapZhipuFinishReason(choice.finish_reason),
                }));
  
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
        const errorMessage = error instanceof Error ? error.message : String(error);
  
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
  
    async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
      // 智谱AI没有专门的token计数API，我们返回一个估算值
      // 这里简单地返回一个固定值，实际应用中可能需要更复杂的估算逻辑
      return {
        totalTokens: 0,
      };
    }
  
    async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
      try {
        let input: string | string[] = '';
  
        // 处理不同的输入格式
        if (Array.isArray(request.contents)) {
          input = request.contents.map((content) => {
            if (typeof content === 'string') {
              return content;
            } else if (this.isContentWithParts(content)) {
              return content.parts.map(part => 
                this.isTextPart(part) ? part.text : (typeof part === 'string' ? part : '')
              ).join('');
            }
            return '';
          });
        } else {
          if (typeof request.contents === 'string') {
            input = request.contents;
          } else if (this.isContentWithParts(request.contents)) {
            input = request.contents.parts.map(part => 
              this.isTextPart(part) ? part.text : (typeof part === 'string' ? part : '')
            ).join('');
          }
        }
  
        const zhipuRequest: ZhipuEmbeddingRequest = {
          model: this.embeddingModel,
          input: input,
        };
  
        const response = await fetch(
          `${this.baseUrl}/embeddings`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(zhipuRequest),
          },
        );
  
        if (!response.ok) {
          throw new Error(`Zhipu Embedding API error: ${response.status} ${response.statusText}`);
        }
  
        const zhipuResponse = await response.json() as ZhipuEmbeddingResponse;
  
        return {
          embeddings: zhipuResponse.data.map(item => ({
            values: item.embedding,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Zhipu Embedding API error: ${errorMessage}`);
      }
    }
  
    private convertToZhipuFormat(request: GenerateContentParameters): ZhipuMessage[] {
      if (!request.contents) {
        return [];
      }
      
      // 确保request.contents是数组
      const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
      
      return contents.map((content) => {
        let contentText = '';
        // 检查content是否为字符串类型
        if (typeof content === 'string') {
          contentText = content;
          return {
            role: 'user', // 默认角色为user
            content: contentText,
          };
        }

         // 处理Content对象类型
        if (this.isContentWithParts(content) && content.parts) {
            contentText = content.parts.map(part => 
                this.isTextPart(part) ? part.text : (typeof part === 'string' ? part : '')
            ).join('');
        }

        const role = (content as any).role;
        return {
          role: role === 'user' ? 'user' : role === 'model' ? 'assistant' : 'system',
          content: contentText,
        };
      });
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
    
    private isContentWithParts(content: Content | Part | string): content is Content & { parts: Part[] } {
      return typeof content === 'object' && content !== null && 'parts' in content;
    }
    
    private isTextPart(part: Part): part is { text: string } {
      return typeof part === 'object' && part !== null && 'text' in part;
    }
  }