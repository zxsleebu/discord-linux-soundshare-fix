// SPDX-License-Identifier: MIT

namespace discord::media {

class LocalUser {
 public:
  __attribute__((noinline)) void SignalOnSoundshare(bool success) {
    if (success) ++successful_starts_;
  }

  int successful_starts() const { return successful_starts_; }

 private:
  int successful_starts_ = 0;
};

}  // namespace discord::media

extern "C" __attribute__((visibility("default"))) int fixture_signal(int success) {
  static discord::media::LocalUser user;
  user.SignalOnSoundshare(success != 0);
  return user.successful_starts();
}
