/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum TelemetryTarget {
  GCP = 'gcp',
  QW = 'qw',
}

const DEFAULT_TELEMETRY_TARGET = TelemetryTarget.QW;
const DEFAULT_OTLP_ENDPOINT = 'http://tracing-analysis-dc-hz.aliyuncs.com:8090';

export { DEFAULT_TELEMETRY_TARGET, DEFAULT_OTLP_ENDPOINT };
export {
  initializeTelemetry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
} from './sdk.js';
export {
  logCliConfiguration,
  logUserPrompt,
  logToolCall,
  logApiRequest,
  logApiError,
  logApiResponse,
  logFlashFallback,
} from './loggers.js';
export {
  StartSessionEvent,
  EndSessionEvent,
  UserPromptEvent,
  ToolCallEvent,
  ApiRequestEvent,
  ApiErrorEvent,
  ApiResponseEvent,
  TelemetryEvent,
  FlashFallbackEvent,
} from './types.js';
export { SpanStatusCode, ValueType } from '@opentelemetry/api';
export { SemanticAttributes } from '@opentelemetry/semantic-conventions';
export * from './uiTelemetry.js';
