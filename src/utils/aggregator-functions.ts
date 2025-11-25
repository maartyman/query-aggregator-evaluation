import {Auth} from "./auth";
import {EventEmitter} from "node:events";

const aggregatorUrl = "http://localhost:5000/";

export async function createAggregatorService(auth: Auth, FnoDescription: string): Promise<string> {
  const response = await auth.fetch(`${aggregatorUrl}config/actors`, {
    method: "POST",
    headers: {
      "content-type": "text/turtle"
    },
    body: FnoDescription,
  });
  if (!response.ok) {
  throw new Error(`Failed to configure aggregator: ${await response.text()}`);
}
return (await response.json()).id;
}

export async function getAggregatorService(auth: Auth, serviceId: string): Promise<any> {
  const response = await auth.fetch(`${aggregatorUrl}${serviceId}/`, {
    method: "GET",
    headers: {
      "Accept": "application/sparql-results+json"
    }
  });
  if (!response.ok) {
  throw new Error(`Failed to get aggregator. status: ${response.status}, body: ${await response.text()}`);
}
return await response.json();
}

export async function waitForAggregatorService(auth: Auth, serviceId: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const serviceUrl = `http://localhost:5000/${serviceId}/events`;
    let sse: undefined | EventEmitter = undefined;
    const abortController = new AbortController();
    while (sse === undefined) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        sse = await auth.sse(serviceUrl, abortController);
      } catch (e) {
        sse = undefined;
      }
    }
    sse!.on("message", async (message) => {
      if (message.eventType === "up-to-date") {
        let fetchWorked = false;
        while (!fetchWorked) {
          try {
            await getAggregatorService(auth, serviceId);
            fetchWorked = true;
          } catch (e) {
            fetchWorked = false;
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        resolve();
        abortController.abort();
      }
    });

    sse!.on("end", () => {
      abortController.abort();
      reject(new Error(`Aggregator service ${serviceUrl} stream ended before reaching up-to-date state.`));
    });

    sse!.on("error", (error) => {
      abortController.abort();
      reject(new Error(`Error while waiting for aggregator service ${serviceUrl}: ${error.message}`));
    });
  });
}
