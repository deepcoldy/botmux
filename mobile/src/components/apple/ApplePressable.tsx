/**
 * Apple-style pressable: pointer-down springs to a squash and springs back on
 * release (WWDC "kill latency" — feedback starts on touch-down, never on
 * release). Optional light haptic on press-in for selection-type rows.
 */
import React, { useCallback } from 'react'
import { Pressable, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated'
import { appleSprings } from '../../theme/apple-tokens'
import { triggerSelection } from '../../platform/haptics'

export function ApplePressable({
  children,
  onPress,
  onLongPress,
  style,
  pressedScale = 0.97,
  haptic = 'none',
  disabled,
  accessibilityRole = 'button',
  accessibilityLabel,
  hitSlop
}: {
  children: React.ReactNode
  onPress?: (event: GestureResponderEvent) => void
  onLongPress?: (event: GestureResponderEvent) => void
  style?: StyleProp<ViewStyle>
  pressedScale?: number
  /** 'selection' fires the light selection haptic on touch-down. */
  haptic?: 'none' | 'selection'
  disabled?: boolean
  accessibilityRole?: 'button' | 'link'
  accessibilityLabel?: string
  hitSlop?: number
}): React.JSX.Element {
  const scale = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }]
  }))

  const onPressIn = useCallback(() => {
    scale.value = withSpring(pressedScale, appleSprings.press)
    if (haptic === 'selection') triggerSelection()
  }, [haptic, pressedScale, scale])
  const onPressOut = useCallback(() => {
    scale.value = withSpring(1, appleSprings.press)
  }, [scale])

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlop}
    >
      <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
    </Pressable>
  )
}
