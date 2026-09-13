'use strict';

/**
 * Which storage folder each stage's output belongs in.
 *
 * Its own module, with no requires, for one reason: the render worker consults
 * it too, and the worker must not be able to reach the database. It holds a
 * shared secret that lives on somebody's laptop, and the entire worker grant is
 * built on it never being able to read tenant content — so it may not pull in a
 * module chain that ends at `config/db`. A table of six strings is not worth
 * weakening that for, and two copies of the table is how a stage ends up filed
 * under one kind on one path and another kind on the other, which is a frame
 * the culling screen cannot find.
 */

const KIND_BY_STAGE = {
  still: 'still', seed_still: 'still', calib_still: 'still', motion: 'clip',
  voice: 'voice', assemble: 'reel', lora_train: 'lora',
};

const kindForStage = (stage) => KIND_BY_STAGE[stage] || 'asset';

module.exports = { KIND_BY_STAGE, kindForStage };
