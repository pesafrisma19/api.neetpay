export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: {
    code: string;
    details?: unknown;
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    [key: string]: unknown;
  };
}

export const successResponse = <T>(data: T, message?: string, meta?: ApiResponse<T>['meta']): ApiResponse<T> => ({
  success: true,
  message,
  data,
  meta,
});

export const errorResponse = (code: string, message: string, details?: unknown): ApiResponse => ({
  success: false,
  message,
  error: {
    code,
    details,
  },
});
