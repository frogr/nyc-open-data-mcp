import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SocrataClient } from "./socrata.js";
import { READ_ONLY_ANNOTATIONS, safe } from "./tools/common.js";
import { queryDataset, queryDatasetDescription, queryDatasetInput, queryDatasetOutput } from "./tools/queryDataset.js";
import {
  restaurantInspections,
  restaurantInspectionsDescription,
  restaurantInspectionsInput,
  restaurantInspectionsOutput,
} from "./tools/restaurantInspections.js";
import { searchDatasets, searchDatasetsDescription, searchDatasetsInput, searchDatasetsOutput } from "./tools/searchDatasets.js";
import {
  serviceRequests311,
  serviceRequests311Description,
  serviceRequests311Input,
  serviceRequests311Output,
} from "./tools/serviceRequests311.js";

export const SERVER_NAME = "nyc-open-data";
export const SERVER_VERSION = "0.1.0";

export function createServer(client: SocrataClient = new SocrataClient({ appToken: process.env.SOCRATA_APP_TOKEN })): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for NYC Open Data. Use restaurant_inspections and service_requests_311 for those common questions; for anything else, find a dataset with search_datasets, then query it with query_dataset. All tools are read-only.",
    },
  );

  server.registerTool(
    "search_datasets",
    {
      title: "Search NYC Open Data catalog",
      description: searchDatasetsDescription,
      inputSchema: searchDatasetsInput,
      outputSchema: searchDatasetsOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe((args) => searchDatasets(client, args)),
  );

  server.registerTool(
    "query_dataset",
    {
      title: "Query a dataset (SoQL)",
      description: queryDatasetDescription,
      inputSchema: queryDatasetInput,
      outputSchema: queryDatasetOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe((args) => queryDataset(client, args)),
  );

  server.registerTool(
    "restaurant_inspections",
    {
      title: "NYC restaurant inspection grades",
      description: restaurantInspectionsDescription,
      inputSchema: restaurantInspectionsInput,
      outputSchema: restaurantInspectionsOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe((args) => restaurantInspections(client, args)),
  );

  server.registerTool(
    "service_requests_311",
    {
      title: "NYC 311 complaint summary",
      description: serviceRequests311Description,
      inputSchema: serviceRequests311Input,
      outputSchema: serviceRequests311Output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safe((args) => serviceRequests311(client, args)),
  );

  return server;
}
