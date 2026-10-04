function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function repositoryCloneCommand(url: string, token: string): string {
  return `git -c ${shellQuote(`http.extraHeader=Authorization: Bearer ${token}`)} clone ${shellQuote(url)}`;
}
