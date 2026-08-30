import { handlers as authHandlers } from "./auth";
import { handlers as videosHandlers } from "./videos";
import { handlers as seedHandlers } from "./_seed";

export const handlers = [...authHandlers, ...videosHandlers, ...seedHandlers];
