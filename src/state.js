'use strict';
const { Board, PIECES } = require('./board');

// Preserve queue positions: a missing preview is unknown, never shift later slots left.
function knownQueue(queue) {
  const end = queue.findIndex(p => !PIECES[p]);
  return queue.slice(0, end < 0 ? queue.length : end);
}

function fromObservation(st, sequence = 0) {
  if (!PIECES[st.current]) throw new Error('Current piece is unknown');
  return { board: Board.fromMatrix(st.stackFilled), current: st.current,
    hold: st.hold || null, queue: knownQueue(st.queue), sequence };
}

function applyMove(state, move) {
  const consumed = move.useHold && !state.hold ? 2 : 1;
  const piece = move.useHold ? state.hold || state.queue[0] : state.current;
  if (state.queue.length < consumed) throw new Error('NEXT exhausted: observation required');
  if (move.piece !== piece) throw new Error('Plan piece does not match state');
  return { board: move.expectedResult.board.clone(), current: state.queue[consumed - 1],
    hold: move.useHold ? state.current : state.hold,
    queue: state.queue.slice(consumed), sequence: state.sequence + 1 };
}

module.exports = { knownQueue, fromObservation, applyMove };
