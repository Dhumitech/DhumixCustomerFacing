import { organizationHeaders, selectedOrganization } from "./organizationScope";
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
  async get(organizationId = selectedOrganization()): Promise<Workspace> {
    const scope = organizationHeaders(organizationId);
    const response = await asDhumiRequest(
      generatedGetWorkspace({
        client: dhumiClient,
        headers: scope,
        throwOnError: true,
      }),
    );
    return response.data;
  },
});

export const catalogueApi = Object.freeze({
  async listScraperLibrary(
    organizationId = selectedOrganization(),
  ): Promise<TemplatePage> {
    const scope = organizationHeaders(organizationId);
    const response = await asDhumiRequest(
      generatedListTemplates({
        client: dhumiClient,
        headers: scope,
        query: { family: "scraper_library", limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async getTemplate(
    slug: string,
    organizationId = selectedOrganization(),
  ): Promise<ServiceTemplate> {
    const scope = organizationHeaders(organizationId);
    const response = await asDhumiRequest(
      generatedGetTemplate({
        client: dhumiClient,
        headers: scope,
        path: { slug },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});

export const servicesApi = Object.freeze({
  async list(organizationId = selectedOrganization()): Promise<ServicePage> {
    const scope = organizationHeaders(organizationId);
    const response = await asDhumiRequest(
      generatedListServices({
        client: dhumiClient,
        headers: scope,
        query: { limit: MAX_PAGE_SIZE },
        throwOnError: true,
      }),
    );
    return response.data;
  },
});
