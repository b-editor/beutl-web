export type ActionResult<T = undefined> =
  | { success: true; data?: T; message?: string }
  | {
      success: false;
      message?: string;
      errors?: Record<string, string[] | undefined>;
    };
