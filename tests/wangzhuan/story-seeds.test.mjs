import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorySeed,
  generateStorySeedWithLuna,
  validateStorySeedRequest
} from "../../server/wangzhuan/story-seeds.mjs";

test("buildStorySeed turns a core plot into three distinct plan-ready variants", () => {
  const seed = buildStorySeed({
    corePlot: "婚内背叛",
    durationSec: 30,
    language: "zh-CN"
  });

  assert.equal(seed.sourceType, "story_seed");
  assert.equal(seed.sourceConfidence, "pattern_inspired");
  assert.equal(seed.variants.length, 3);
  assert.ok(seed.variants.every((variant) => variant.qualityGate.status === "pass"));
  assert.ok(seed.variants.every((variant) => variant.fissionAxes.length >= 4));
  assert.ok(seed.variants.every((variant) => variant.decomposition.scene && variant.decomposition.hook));
  assert.ok(seed.variants.every((variant) => variant.decomposition.sourceAssemblyMode === "independent_segments"));
  assert.ok(seed.variants.every((variant) => variant.decomposition.seedanceSlices.length === 3));
  assert.ok(seed.variants.every((variant) => variant.decomposition.seedanceSlices.every((slice) => slice.continuityMode === "independent_slice" && !slice.continuityReferenceNeeded)));
  assert.ok(seed.variants.every((variant) => variant.decomposition.seedanceSlices.every((slice) => slice.sliceDurationSec >= 8 && slice.sliceDurationSec <= 15)));
  assert.ok(seed.variants.every((variant) => new Set(variant.decomposition.seedanceSlices.map((slice) => slice.continuityGroupId)).size === 3));
  assert.notEqual(seed.variants[0].openingAction, seed.variants[1].openingAction);
  assert.notEqual(seed.variants[1].reversalObject, seed.variants[2].reversalObject);
});

test("validateStorySeedRequest rejects empty and overlong core plots before generation", () => {
  assert.throws(
    () => validateStorySeedRequest({ corePlot: " " }),
    { code: "validation_error" }
  );
  assert.throws(
    () => validateStorySeedRequest({ corePlot: "a".repeat(81) }),
    { code: "validation_error" }
  );
});

test("generateStorySeedWithLuna preserves three generated short plans", async () => {
  const seed = await generateStorySeedWithLuna({}, { corePlot: "婚内背叛", durationSec: 30 }, {
    callLlm: async (config, messages) => {
      assert.equal(config.model, "gpt-5.6-luna");
      assert.equal(messages.length, 2);
      return JSON.stringify({
        variants: [
          { title: "晚宴录音", scene: "豪门晚宴长餐桌", protagonist: "被背叛的妻子", antagonist: "丈夫与第三者", openingAction: "丈夫当众把主位让给第三者", reversalObject: "录音手机", emotion: "证据反击", ending: "律师来电响起，所有人沉默", episodeHighlights: [{ title: "晚宴录音", scene: "豪门晚宴长餐桌", protagonist: "被背叛的妻子", antagonist: "丈夫与第三者", openingAction: "丈夫当众把主位让给第三者", reversalObject: "录音手机", ending: "律师来电响起，所有人沉默" }, { title: "车库账本", scene: "集团地下车库", protagonist: "被夺权的女高管", antagonist: "试图封口的前夫", openingAction: "前夫抢走女主的董事证件", reversalObject: "加密账本", ending: "电梯门开，审计人员站在门外" }, { title: "年会冻结", scene: "集团年会颁奖台", protagonist: "被撤职的前妻", antagonist: "宣布新任命的前夫", openingAction: "前夫当众撕掉女主任命书", reversalObject: "冻结令", ending: "审计负责人从侧门举起文件" }] },
          { title: "产房手环", scene: "医院产房走廊", protagonist: "刚生产的妻子", antagonist: "前夫与新娘", openingAction: "新娘闯进产房要求带走孩子", reversalObject: "婴儿手环", emotion: "身份震撼", ending: "护士念出手环信息，前夫僵住", episodeHighlights: [{ title: "产房手环", scene: "医院产房走廊", protagonist: "刚生产的妻子", antagonist: "前夫与新娘", openingAction: "新娘闯进产房要求带走孩子", reversalObject: "婴儿手环", ending: "护士念出手环信息，前夫僵住" }, { title: "病房遗嘱", scene: "医院病房门口", protagonist: "被赶出病房的女儿", antagonist: "抢夺遗产的继母", openingAction: "继母当众撕掉探视登记", reversalObject: "遗嘱封套", ending: "主治医生拿着封套停在门口" }, { title: "灵堂密钥", scene: "追思会签到处", protagonist: "被质疑身份的女儿", antagonist: "夺走遗物的继母", openingAction: "继母命人将女主赶出签到处", reversalObject: "保险箱密钥", ending: "律师念出钥匙编号，全场安静" }] },
          { title: "婚礼股权", scene: "婚礼签约台", protagonist: "被轻视的新娘", antagonist: "准婆婆与新郎", openingAction: "准婆婆撕毁新娘的婚前协议", reversalObject: "控股文件", emotion: "地位逆转", ending: "董事会代表推门进入礼堂", episodeHighlights: [{ title: "婚礼股权", scene: "婚礼签约台", protagonist: "被轻视的新娘", antagonist: "准婆婆与新郎", openingAction: "准婆婆撕毁新娘的婚前协议", reversalObject: "控股文件", ending: "董事会代表推门进入礼堂" }, { title: "祭坛信托", scene: "婚礼祭坛前", protagonist: "被逼签字的继承人", antagonist: "觊觎信托的新郎", openingAction: "新郎将信托文件压到新娘手边", reversalObject: "董事会冻结令", ending: "律师举起冻结令，全场宾客回头" }, { title: "酒店地契", scene: "婚礼酒店大堂", protagonist: "被赶出婚礼的继承人", antagonist: "索要婚房的新郎", openingAction: "新郎将房卡扔给保安", reversalObject: "酒店地契", ending: "经理改口称呼，保安停在原地" }] }
        ]
      });
    }
  });

  assert.equal(seed.sourceConfidence, "luna_generated");
  assert.equal(seed.generationModel, "gpt-5.6-luna");
  assert.equal(seed.variants.length, 3);
  assert.equal(seed.variants[1].reversalObject, "婴儿手环");
  assert.equal(seed.variants[2].decomposition.scene, "婚礼签约台");
});
