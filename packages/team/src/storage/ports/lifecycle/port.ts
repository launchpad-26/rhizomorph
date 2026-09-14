/**
 * THE LIFECYCLE PORT — closing the connection.
 *
 * Its own port rather than a lodger on another, because `close` belongs to no
 * capability. A port with a six-line SQL module is not a defect here; it is the
 * shape proving the layout scales down as well as up.
 */
export interface LifecyclePort {
  close(): Promise<void>
}
