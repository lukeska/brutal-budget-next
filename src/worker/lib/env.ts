export type SessionUser = { id: string; tokenHash: string };

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser };
};
