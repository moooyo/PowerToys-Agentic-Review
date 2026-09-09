import { HttpPublicationAdapter } from "./http-adapter";
export const publications = new HttpPublicationAdapter();
export const publicationQueryRoot = ["publications"] as const;
export type { PublicationAdapter } from "./adapter";
export { HttpPublicationAdapter } from "./http-adapter";
