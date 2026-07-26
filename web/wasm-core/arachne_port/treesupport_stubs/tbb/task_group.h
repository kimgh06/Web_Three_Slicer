#pragma once
namespace tbb { class task_group { public: template<class F> void run(F&& f){ f(); } void wait(){} }; }
