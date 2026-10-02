# Changelog

## [0.1.2](https://github.com/DragosMocrii/project-adhd/compare/v0.1.1...v0.1.2) (2026-10-02)


### Features

* **readme:** add centered mascot image ([73f1c57](https://github.com/DragosMocrii/project-adhd/commit/73f1c57db7392368d7b32cb0f74ebf5991618b7c))

## [0.1.1](https://github.com/DragosMocrii/project-adhd/compare/v0.1.0...v0.1.1) (2026-10-01)


### Features

* **initialize:** infer Git identity from host config ([cf93961](https://github.com/DragosMocrii/project-adhd/commit/cf93961e19bdc43d463b98c74465b775ee8b8b00))

## 0.1.0 (2026-09-30)


### ⚠ BREAKING CHANGES

* **install:** install.sh checks out the newest vX.Y.Z tag instead of main. Set ADHD_REF=main to follow main.
* **update:** adhd update now moves the installation to the newest vX.Y.Z tag instead of pulling main. Use adhd update --ref main to keep following main.
* **devcontainer:** remove host docker access from the workspace

### Features

* add adhd attach for existing worktrees in untracked mode ([05dfe13](https://github.com/DragosMocrii/project-adhd/commit/05dfe13240457bd6eccaa27a386eb320cea587e4))
* add adhd detach and adhd update ([e141094](https://github.com/DragosMocrii/project-adhd/commit/e141094c6568c0cbbb5084fa584d3395773f13ab))
* add adhd version ([856a90a](https://github.com/DragosMocrii/project-adhd/commit/856a90a71898c11b1ea9fd2279f221d6b81a6764))
* add AGENT_TOOLS selection library ([f8194ae](https://github.com/DragosMocrii/project-adhd/commit/f8194ae7ab6f831f49d95d23d7f9b8e63db7aa67))
* add attach --track, clone targets, and adhd new ([ea9d05b](https://github.com/DragosMocrii/project-adhd/commit/ea9d05b6d476b6bf64b27458ee32188ee7e02b54))
* add install.sh for the adhd host CLI ([1c1c9de](https://github.com/DragosMocrii/project-adhd/commit/1c1c9de4d8c2d121bac721d73a5602b4ba6c4368))
* add project identity initialization ([517298c](https://github.com/DragosMocrii/project-adhd/commit/517298c37a7fea5c35c9a65ef795d167181905b5))
* add scaffold verification and usage docs ([9d062e5](https://github.com/DragosMocrii/project-adhd/commit/9d062e5e1d4cf2bb9af74193bffec06f64a4ce61))
* adhd — attach the Dev Container to any repository ([3f6238c](https://github.com/DragosMocrii/project-adhd/commit/3f6238cb98def55a730e17fb8b6773d7342ec881))
* **attach:** record the project-adhd version in the marker ([703c8b7](https://github.com/DragosMocrii/project-adhd/commit/703c8b7b9a9cfc4603289e4ee449869fa81028ee))
* bootstrap agent tools in post-create ([6cda31d](https://github.com/DragosMocrii/project-adhd/commit/6cda31d38db1bbf6f696cfd0043a2a5b54449a2d))
* define generic Bun TypeScript contract ([5a1f1d7](https://github.com/DragosMocrii/project-adhd/commit/5a1f1d783aef98249e81c2bdbef2f4809e49eb52))
* derive per-worktree Compose instances and shared agent state in initialize.sh ([f962677](https://github.com/DragosMocrii/project-adhd/commit/f962677cc2679f8f96c5462e6188d32f45b280fb))
* **devcontainer:** add gemini cli ([cc4ace8](https://github.com/DragosMocrii/project-adhd/commit/cc4ace86aac6e493a997fd62f2d5e44e09779be8))
* **devcontainer:** remove host docker access from the workspace ([4ee30c0](https://github.com/DragosMocrii/project-adhd/commit/4ee30c0380c694f27826a041d3dc6e995364d219))
* gate post-create installation and setup by AGENT_TOOLS ([145f9fd](https://github.com/DragosMocrii/project-adhd/commit/145f9fdcc8e80940aaf70c1993c4b6f76392b1f6))
* **initialize:** warn when COMPOSE_PROJECT_NAME may override the worktree's project ([9c4a5d6](https://github.com/DragosMocrii/project-adhd/commit/9c4a5d62895ecd6bf3019abfe70a709da9a4d865))
* **install:** install the newest release by default ([db47ad3](https://github.com/DragosMocrii/project-adhd/commit/db47ad35f4e6883b9ed4c9d4c0503cee3d2b0b12))
* isolate devcontainer Compose state ([7987427](https://github.com/DragosMocrii/project-adhd/commit/798742747a9e186ee244eaa5f189211b82945594))
* refresh attached repositories without clobbering edited runtime files ([baad0ba](https://github.com/DragosMocrii/project-adhd/commit/baad0baccd0de59b8ec21697ebb5d324e97aa702))
* report pass, fail, and skip per selected tool in verify ([e947e36](https://github.com/DragosMocrii/project-adhd/commit/e947e364e4a58c97d8eeeb727b5512b5fe62de49))
* serialize shared-state setup across containers with flock ([a7e0693](https://github.com/DragosMocrii/project-adhd/commit/a7e06930eccadad51bbc1c2587a2a09df75e970d))
* share agent volumes across repositories and mount at /workspaces/&lt;name&gt; ([ad25e20](https://github.com/DragosMocrii/project-adhd/commit/ad25e208cfe6f6c8b52e3c719c5267666f0ecc59))
* **update:** follow the newest release and add --ref ([47d6601](https://github.com/DragosMocrii/project-adhd/commit/47d660114ca3db1931dfbaa9a759411a42e74a14))
* **verify:** check and document python3 availability ([9d4ac8f](https://github.com/DragosMocrii/project-adhd/commit/9d4ac8f629c01d866d16163a8a031a3d90f4925e))


### Bug Fixes

* add shellcheck disable comments and quote variable for SC2016/SC2086 ([40883f4](https://github.com/DragosMocrii/project-adhd/commit/40883f45e0d035effc481ae1200934b0428160ed))
* address code review findings in plugin-detection parsers ([ee5ad08](https://github.com/DragosMocrii/project-adhd/commit/ee5ad08a0f86bd397cc88a9107ff7c084583915c))
* align workspace name in bun.lock to match package.json ([1a56651](https://github.com/DragosMocrii/project-adhd/commit/1a56651f7490d53bd09ef08ddb3ad50b326ba364))
* **attach,detach:** refuse to follow symlinks out of the worktree ([28ea1be](https://github.com/DragosMocrii/project-adhd/commit/28ea1be4c2e4550ba2cc36643aca5bf3fc31187b))
* **attach:** offer each shipped runtime version only once ([bcf53f5](https://github.com/DragosMocrii/project-adhd/commit/bcf53f5df9f547e710f466ecd60c07cf4c4a57f1))
* **attach:** roll back a failed attach so it can be retried ([79fcb6e](https://github.com/DragosMocrii/project-adhd/commit/79fcb6e0ea5733022be5d2ebc467f6651cb4004e))
* clarify plugin-detection exception and move shellcheck note ([68b3d8b](https://github.com/DragosMocrii/project-adhd/commit/68b3d8b2803369e99f0d52bac47e4af73bb7ac62))
* **devcontainer:** correct the frozen lock ordering ([1957e6a](https://github.com/DragosMocrii/project-adhd/commit/1957e6a76f6a9ff882429a64a69c9fba40613be0))
* **devcontainer:** disable gemini cli browser auth ([6b24367](https://github.com/DragosMocrii/project-adhd/commit/6b24367f80f1acf2a6e743bfd3ba1e91decc3def))
* discover Claude plugin marketplace ([215941c](https://github.com/DragosMocrii/project-adhd/commit/215941c75f1e2c965c5d9369ceebfe87959030d6))
* final-review minors for detach, install, initialize, and docs ([6bf29fa](https://github.com/DragosMocrii/project-adhd/commit/6bf29fa622b04afb821ea6d1cf96a80de9d88411))
* harden launch-readiness gaps from final branch review ([a6c3623](https://github.com/DragosMocrii/project-adhd/commit/a6c362387d510e267e5d42e38750ba3626f611ed))
* keep the post-create lock fd out of child processes ([341cbab](https://github.com/DragosMocrii/project-adhd/commit/341cbabbe955eea90e6fbe00746d6371ff70ff16))
* keep this repository's legacy local files ignored ([227e5bb](https://github.com/DragosMocrii/project-adhd/commit/227e5bb599c809ae534e7e37a74730b86c1e3813))
* make agent-tools.sh bash 3.2-safe and guard host scripts statically ([2d6e117](https://github.com/DragosMocrii/project-adhd/commit/2d6e117983b1e828dc3d0e550763379f4105a496))
* make post-create.sh library sourcing path-portable and PATH-independent ([161751a](https://github.com/DragosMocrii/project-adhd/commit/161751aa5d97f3ca11d454c3e3113a86b7dac446))
* make the scaffold auth bootstrap portable ([cf2c0cc](https://github.com/DragosMocrii/project-adhd/commit/cf2c0cc1e758d2df7f38701c30968950c573c895))
* make verify test helper hermetic and drop tr dependency in agent-tools ([e42c374](https://github.com/DragosMocrii/project-adhd/commit/e42c374dcc539daa76a0f345b75515d7731ef606))
* **post-create:** resolve dependency install-script warnings ([3071fc9](https://github.com/DragosMocrii/project-adhd/commit/3071fc90a14488f741eba210e188fdf586f5003c))
* **post-create:** skip installed agent CLIs and document codex catalog auth ([0d443f2](https://github.com/DragosMocrii/project-adhd/commit/0d443f24b7faa5589067c03609f5781e35d45c69))
* prepare installer parent directories ([ee1ec2d](https://github.com/DragosMocrii/project-adhd/commit/ee1ec2d8b1fd9e5d20fe4039173df252f399e8e9))
* refresh Claude plugin marketplace ([c5a7ec2](https://github.com/DragosMocrii/project-adhd/commit/c5a7ec23de7d362718da4e38e800ee7f8a570035))
* require newline in persisted project state ([98ee165](https://github.com/DragosMocrii/project-adhd/commit/98ee165db140ea3c028c57ccc6f82fe82e911c69))
* satisfy ShellCheck in initialize.sh ([dd36ad3](https://github.com/DragosMocrii/project-adhd/commit/dd36ad3bdbe1f3b72c580d8c90f91d321c5404c5))
* **update:** report a move even when the version string is unchanged ([466558f](https://github.com/DragosMocrii/project-adhd/commit/466558f6e8aeec3ce54ddb136b552a79790b69b4))
* use tr for lowercasing in agent-tools.sh as specified ([56a364c](https://github.com/DragosMocrii/project-adhd/commit/56a364cb3dc54b2cebf7ea4ceb31cc8639b67945))
