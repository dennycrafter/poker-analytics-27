// Bottom tab bar (brief 3), active tab green. Reports is not part of the
// native scope (see README), so the bar carries four tabs.
import { Tabs } from 'expo-router';

import { Icon, type IconName } from '../../../src/ui/icons';
import { colors } from '../../../src/ui/theme';

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: 'Feed', icon: 'feed' },
  { name: 'stats', title: 'Statistics', icon: 'stats' },
  { name: 'calendar', title: 'Calendar', icon: 'calendar' },
  { name: 'more', title: 'More', icon: 'more' },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: { backgroundColor: colors.bg3, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.text2,
        tabBarLabelStyle: { fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
      }}>
      {TABS.map(t => (
        <Tabs.Screen key={t.name} name={t.name}
          options={{ title: t.title, tabBarIcon: ({ focused }) => <Icon name={t.icon} color={focused ? colors.accent : colors.text2} /> }} />
      ))}
    </Tabs>
  );
}
