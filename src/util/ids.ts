/** A task or lane id: what Docker names and labels, and halt scopes, are built from. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A repository, `owner/name`, in lowercase: GitHub's names are case-insensitive. */
export const REPO_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
