function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Git sends `USER:TOKEN` as Basic credentials; the server ignores the user name. */
export function authenticatedCloneUrl(url: string, token: string): string {
  const authenticated = new URL(url);
  authenticated.username = "git";
  authenticated.password = token;
  return authenticated.toString();
}

export function repositoryCloneCommand(url: string, token: string): string {
  return `git clone ${shellQuote(authenticatedCloneUrl(url, token))}`;
}
