import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  getTemplate as generatedGetTemplate,
  getWorkspace as generatedGetWorkspace,
  listServices as generatedListServices,
  listTemplates as generatedListTemplates,
  type ServicePage,
  type ServiceTemplate,
  type TemplatePage,
  type Workspace,
} from "./generated";

const MAX_PAGE_SIZE = 100;

export const workspaceApi = Object.freeze({
  async get(): Promise<Workspace> {
    const response = await asDhumiRequest(
      generatedGetWorkspace({ client: dhumiClient, throwOnError: true }),
    );
    return response.data;
  },
});

export const catalogueApi = Object.freeze({
  async listScraperLibrary(): Promise<TemplatePage> {
    const response = await asDhumiRequest(
      generatedListTemplates({
        client: dhumiClient,
        query: { family: "scraper_library", limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async getTemplate(slug: string): Promise<ServiceTemplate> {
    const response = await asDhumiRequest(
      generatedGetTemplate({
        client: dhumiClient,
        path: { slug },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});

export const servicesApi = Object.freeze({
  async list(): Promise<ServicePage> {
    const response = await asDhumiRequest(
      generatedListServices({
        client: dhumiClient,
        query: { limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});
