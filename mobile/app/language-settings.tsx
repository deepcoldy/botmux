import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft, Languages } from 'lucide-react-native'
import {
  mobileLocaleDisplayName,
  useMobileI18n,
  type MobileLanguagePreference
} from '../src/i18n/mobile-i18n'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

const OPTIONS: readonly MobileLanguagePreference[] = ['system', 'en', 'zh-CN']

export default function LanguageSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { languagePreference, locale, setLanguagePreference, t } = useMobileI18n()

  const optionLabel = (value: MobileLanguagePreference): string => {
    if (value === 'system') return t('System default')
    return mobileLocaleDisplayName(value, locale)
  }

  const optionSubtitle = (value: MobileLanguagePreference): string | undefined => {
    if (value !== 'system') return undefined
    return t('Current language: {{language}}', {
      language: mobileLocaleDisplayName(locale, locale)
    })
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Back')}
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('Language')}</Text>
      </View>

      <Text style={styles.description}>
        {t(
          'Use the app language selected below. System default follows the language configured on this device.'
        )}
      </Text>

      <View style={styles.section}>
        {OPTIONS.map((option, index) => {
          const selected = option === languagePreference
          return (
            <View key={option}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => setLanguagePreference(option)}
              >
                <Languages size={16} color={colors.textSecondary} />
                <View style={styles.rowCopy}>
                  <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>
                    {optionLabel(option)}
                  </Text>
                  {optionSubtitle(option) ? (
                    <Text style={styles.rowHint}>{optionSubtitle(option)}</Text>
                  ) : null}
                </View>
                {selected ? <Check size={17} color={colors.textPrimary} /> : null}
              </Pressable>
            </View>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.bodySize - 1,
    lineHeight: 20,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowCopy: { flex: 1 },
  rowLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  rowLabelSelected: { fontWeight: '700' },
  rowHint: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.md + 2 + 26
  }
})
