import { PageController } from '../PageController'
import { ParentPageControllerHost, startParentPageControllerHost } from '../parent-bridge/host'
import './parent-host.css'

/**
 * Public browser-script surface for the parent-page controller host.
 *
 * Keep this entry deliberately narrow: it contains the DOM controller and the
 * authenticated parent bridge, including its optional explicitly authorized
 * child-frame proxy. Agent, LLM, and UI packages belong to the parent
 * application's own bundle and are not part of this IIFE.
 */
export { PageController, ParentPageControllerHost, startParentPageControllerHost }
