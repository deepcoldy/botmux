import { createLocalizedCatalog } from '@/i18n/localized-catalog'

/**
 * Star-on-GitHub settings search entries removed (product growth UG).
 * Catalog stays empty so general search no longer surfaces star/open-repo promo.
 */
export const getGeneralSupportSearchEntries = createLocalizedCatalog(() => [])
