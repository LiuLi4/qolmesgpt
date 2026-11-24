/** Compare repository identity across GitLab's HTTP and SSH clone URLs. Paths remain case-sensitive. */
export function repositoryIdentity(value: string): string {
  const scp = /^git@([^\s/:]+):([^\s]+)$/.exec(value);
  const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
  if (!["http:", "https:", "ssh:"].includes(url.protocol)
    || url.password || url.search || url.hash
    || (url.protocol === "ssh:" ? url.username !== "git" : Boolean(url.username))) {
    throw new Error("Invalid GitLab repository URL");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path || path === "/") throw new Error("Invalid GitLab repository URL");
  const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
  return `${url.hostname.toLowerCase()}${port ? `:${port}` : ""}${path}`;
}
