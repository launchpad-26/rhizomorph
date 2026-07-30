import { createContext, useContext, type ReactNode } from 'react'

export type Mode = 'live' | 'replay'

const ModeContext = createContext<Mode>('live')

export interface ModeProviderProps {
  mode?: Mode
  children: ReactNode
}

/** Stub: always `live` today. The replay issue adds the scrubber that flips this. */
export function ModeProvider({ mode = 'live', children }: ModeProviderProps) {
  return <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>
}

export function useMode(): Mode {
  return useContext(ModeContext)
}
