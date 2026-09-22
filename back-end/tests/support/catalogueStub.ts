import type { ListCatalogTemplatesService } from "../../src/services/catalogue/listCatalogTemplatesService.js";
import type { GetCatalogTemplateService } from "../../src/services/catalogue/getCatalogTemplateService.js";

export const stubListCatalogTemplatesService: ListCatalogTemplatesService = {
  async list() {
    throw new Error("stub list-catalogue-Templates service was not expected to be called");
  },
};

export const stubGetCatalogTemplateService: GetCatalogTemplateService = {
  async get() {
    throw new Error("stub get-catalogue-Template service was not expected to be called");
  },
};
