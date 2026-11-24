import { pathToFileURL } from "node:url";

export async function checkCompanyKey(baseUrl, apiKey, fetcher = fetch) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/key-check`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Company model key-check returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.valid !== true) throw new Error("Company model key-check did not confirm a valid key");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkCompanyKey(process.env.API_BASE, process.env.API_KEY);
    console.log("Company model key validated");
  } catch (error) {
    // Network errors may contain headers or response bodies. Print only known safe errors.
    const message = error instanceof Error && error.message.startsWith("Company model key-check ")
      ? error.message : "Company model key-check failed (network, timeout or invalid response)";
    console.error(message);
    process.exitCode = 1;
  }
}
